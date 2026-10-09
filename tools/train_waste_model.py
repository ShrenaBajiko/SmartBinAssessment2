"""Train the default lightweight waste classifier and export it for TensorFlow.js.

Model : MobileNetV2 (width multiplier 0.5, 160x160 input, ImageNet pretrained)
        + global average pooling + dropout + dense softmax.
Data  : TrashNet (MIT licence) - https://huggingface.co/datasets/garythung/trashnet
        6 classes: cardboard, glass, metal, paper, plastic, trash.

Preprocessing matches app.js: centre-crop to square, bilinear resize, scale to [-1, 1].

Usage (TensorFlow 2.15 / Keras 2, tensorflowjs 4.x):
    python train_waste_model.py --data path/to/dataset-resized --out ../models/waste-mobilenetv2
"""
import argparse
import json
import pathlib
import random

import numpy as np
import tensorflow as tf

IMG = 160
ALPHA = 0.5
SEED = 42


def split_files(data_dir):
    """Stratified 70/15/15 split so every class appears in each set."""
    classes = sorted(p.name for p in data_dir.iterdir() if p.is_dir())
    rng = random.Random(SEED)
    splits = {"train": [], "val": [], "test": []}
    for idx, name in enumerate(classes):
        files = sorted(str(f) for f in (data_dir / name).iterdir() if f.suffix.lower() in {".jpg", ".jpeg", ".png"})
        rng.shuffle(files)
        n_val = n_test = round(len(files) * 0.15)
        splits["test"] += [(f, idx) for f in files[:n_test]]
        splits["val"] += [(f, idx) for f in files[n_test:n_test + n_val]]
        splits["train"] += [(f, idx) for f in files[n_test + n_val:]]
    return classes, splits


def load_image(path, label):
    img = tf.io.decode_image(tf.io.read_file(path), channels=3, expand_animations=False)
    h, w = tf.shape(img)[0], tf.shape(img)[1]
    size = tf.minimum(h, w)
    img = tf.image.crop_to_bounding_box(img, (h - size) // 2, (w - size) // 2, size, size)
    img = tf.image.resize(img, [IMG, IMG], method="bilinear")
    return img, label


def augment(img, label):
    # Simulates hand-held tablet photos: framing, rotation, lighting.
    img = tf.image.random_flip_left_right(img)
    img = tf.image.rot90(img, tf.random.uniform([], 0, 4, dtype=tf.int32))
    scale = tf.random.uniform([], 0.8, 1.0)
    crop = tf.cast(IMG * scale, tf.int32)
    img = tf.image.random_crop(img, [crop, crop, 3])
    img = tf.image.resize(img, [IMG, IMG])
    img = tf.image.random_brightness(img, 40.0)
    img = tf.image.random_contrast(img, 0.75, 1.25)
    img = tf.image.random_saturation(img, 0.75, 1.25)
    return tf.clip_by_value(img, 0.0, 255.0), label


def normalise(img, label):
    return img / 127.5 - 1.0, label


def make_dataset(items, training):
    paths, labels = zip(*items)
    ds = tf.data.Dataset.from_tensor_slices((list(paths), list(labels)))
    if training:
        ds = ds.shuffle(len(items), seed=SEED)
    ds = ds.map(load_image, num_parallel_calls=tf.data.AUTOTUNE).cache()
    if training:
        ds = ds.map(augment, num_parallel_calls=tf.data.AUTOTUNE)
    return ds.map(normalise).batch(32).prefetch(tf.data.AUTOTUNE)


def build_model(num_classes):
    base = tf.keras.applications.MobileNetV2(input_shape=(IMG, IMG, 3), alpha=ALPHA,
                                             include_top=False, weights="imagenet")
    base.trainable = False
    x = tf.keras.layers.GlobalAveragePooling2D()(base.output)
    x = tf.keras.layers.Dropout(0.3)(x)
    out = tf.keras.layers.Dense(num_classes, activation="softmax", name="predictions")(x)
    return tf.keras.Model(base.input, out, name="waste_mobilenetv2"), base


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, type=pathlib.Path)
    parser.add_argument("--out", required=True, type=pathlib.Path)
    args = parser.parse_args()
    tf.keras.utils.set_random_seed(SEED)

    classes, splits = split_files(args.data)
    print("Classes:", classes, {k: len(v) for k, v in splits.items()})
    train, val, test = (make_dataset(splits[k], k == "train") for k in ("train", "val", "test"))

    counts = np.bincount([label for _, label in splits["train"]], minlength=len(classes))
    class_weight = {i: len(splits["train"]) / (len(classes) * c) for i, c in enumerate(counts)}

    model, base = build_model(len(classes))
    stop = tf.keras.callbacks.EarlyStopping(monitor="val_accuracy", patience=6, restore_best_weights=True)

    # Phase 1: train only the new classifier head.
    model.compile(tf.keras.optimizers.Adam(1e-3), "sparse_categorical_crossentropy", ["accuracy"])
    model.fit(train, validation_data=val, epochs=15, class_weight=class_weight, callbacks=[stop], verbose=2)

    # Phase 2: fine-tune the top of the backbone. BatchNorm stays frozen (inference mode).
    base.trainable = True
    for layer in base.layers[:len(base.layers) // 2]:
        layer.trainable = False
    for layer in base.layers:
        if isinstance(layer, tf.keras.layers.BatchNormalization):
            layer.trainable = False
    model.compile(tf.keras.optimizers.Adam(1e-4), "sparse_categorical_crossentropy", ["accuracy"])
    model.fit(train, validation_data=val, epochs=40, class_weight=class_weight, callbacks=[stop], verbose=2)

    # Held-out test set.
    y_true, y_pred = [], []
    for x, y in test:
        y_true += list(y.numpy())
        y_pred += list(np.argmax(model.predict(x, verbose=0), axis=1))
    y_true, y_pred = np.array(y_true), np.array(y_pred)
    test_acc = float((y_true == y_pred).mean())
    print(f"\nTest accuracy: {test_acc:.3f}")
    print("Per class:", {c: round(float((y_pred[y_true == i] == i).mean()), 3) for i, c in enumerate(classes)})
    confusion = tf.math.confusion_matrix(y_true, y_pred, num_classes=len(classes)).numpy()
    print("Confusion matrix (rows = true):\n", classes, "\n", confusion)

    # Export: TF.js layers model with float16 weights + metadata the app reads for labels.
    import tensorflowjs as tfjs
    args.out.mkdir(parents=True, exist_ok=True)
    tfjs.converters.save_keras_model(model, str(args.out), quantization_dtype_map={"float16": "*"})
    metadata = {
        "labels": classes,
        "modelName": "waste-mobilenetv2-0.5-160",
        "architecture": f"MobileNetV2 alpha={ALPHA}, input {IMG}x{IMG}x3",
        "normalization": "-1to1",
        "dataset": "TrashNet (MIT) https://huggingface.co/datasets/garythung/trashnet",
        "testAccuracy": round(test_acc, 4),
        "params": int(model.count_params()),
    }
    (args.out / "metadata.json").write_text(json.dumps(metadata, indent=2))
    print("Saved to", args.out)


if __name__ == "__main__":
    main()
