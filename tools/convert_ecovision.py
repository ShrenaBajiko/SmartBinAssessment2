"""Convert the EcoVision MobileNetV3 PyTorch model to ONNX (step 1 of the TF.js conversion).

Source model : https://huggingface.co/AmadFR/ecovision_mobilenetv3 (MIT licence)
Architecture : torchvision MobileNetV3-Large, classifier replaced with 10 outputs.

The ImageNet normalisation from the model's preprocessor_config.json is built into the
exported graph, so the app feeds raw RGB pixels (0-255) resized to 224x224.

Pipeline (see README "Default model"):
    python convert_ecovision.py --weights pytorch_model.bin --out ecovision.onnx
    onnx2tf -i ecovision.onnx -o saved_model
    tensorflowjs_converter --input_format=tf_saved_model --quantize_float16="*" saved_model ../models/ecovision-mobilenetv3

MobileNetV3-Large is defined here (matching torchvision's module names) so only
PyTorch is needed; load_state_dict(strict=True) proves the structure is identical.
"""
import argparse

import torch
from torch import nn

LABELS = ["battery", "biological", "cardboard", "clothes", "glass",
          "metal", "paper", "plastic", "shoes", "trash"]

# (in, kernel, expanded, out, use_se, activation, stride) - torchvision mobilenet_v3_large
CONFIG = [
    (16, 3, 16, 16, False, "RE", 1), (16, 3, 64, 24, False, "RE", 2), (24, 3, 72, 24, False, "RE", 1),
    (24, 5, 72, 40, True, "RE", 2), (40, 5, 120, 40, True, "RE", 1), (40, 5, 120, 40, True, "RE", 1),
    (40, 3, 240, 80, False, "HS", 2), (80, 3, 200, 80, False, "HS", 1), (80, 3, 184, 80, False, "HS", 1),
    (80, 3, 184, 80, False, "HS", 1), (80, 3, 480, 112, True, "HS", 1), (112, 3, 672, 112, True, "HS", 1),
    (112, 5, 672, 160, True, "HS", 2), (160, 5, 960, 160, True, "HS", 1), (160, 5, 960, 160, True, "HS", 1),
]


def make_divisible(v, divisor=8):
    new_v = max(divisor, int(v + divisor / 2) // divisor * divisor)
    return new_v + divisor if new_v < 0.9 * v else new_v


def conv_bn(inp, out, k, stride=1, groups=1, act=None):
    layers = [nn.Conv2d(inp, out, k, stride, (k - 1) // 2, groups=groups, bias=False),
              nn.BatchNorm2d(out, eps=0.001, momentum=0.01)]
    if act:
        layers.append(nn.Hardswish() if act == "HS" else nn.ReLU())
    return nn.Sequential(*layers)


class SqueezeExcitation(nn.Module):
    def __init__(self, channels, squeeze):
        super().__init__()
        self.avgpool = nn.AdaptiveAvgPool2d(1)
        self.fc1, self.fc2 = nn.Conv2d(channels, squeeze, 1), nn.Conv2d(squeeze, channels, 1)
        self.activation, self.scale_activation = nn.ReLU(), nn.Hardsigmoid()

    def forward(self, x):
        s = self.scale_activation(self.fc2(self.activation(self.fc1(self.avgpool(x)))))
        return x * s


class InvertedResidual(nn.Module):
    def __init__(self, inp, k, exp, out, use_se, act, stride):
        super().__init__()
        self.use_res_connect = stride == 1 and inp == out
        layers = []
        if exp != inp:
            layers.append(conv_bn(inp, exp, 1, act=act))
        layers.append(conv_bn(exp, exp, k, stride, groups=exp, act=act))
        if use_se:
            layers.append(SqueezeExcitation(exp, make_divisible(exp // 4)))
        layers.append(conv_bn(exp, out, 1))
        self.block = nn.Sequential(*layers)

    def forward(self, x):
        y = self.block(x)
        return x + y if self.use_res_connect else y


class MobileNetV3Large(nn.Module):
    def __init__(self, num_classes=10):
        super().__init__()
        self.features = nn.Sequential(conv_bn(3, 16, 3, 2, act="HS"),
                                      *[InvertedResidual(*c) for c in CONFIG],
                                      conv_bn(160, 960, 1, act="HS"))
        self.avgpool = nn.AdaptiveAvgPool2d(1)
        self.classifier = nn.Sequential(nn.Linear(960, 1280), nn.Hardswish(), nn.Dropout(0.2),
                                        nn.Linear(1280, num_classes))

    def forward(self, x):
        return self.classifier(torch.flatten(self.avgpool(self.features(x)), 1))


class Deployable(nn.Module):
    """Raw 0-255 RGB (NCHW) in, class probabilities out."""
    def __init__(self, net):
        super().__init__()
        self.net = net
        self.register_buffer("mean", torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1) * 255)
        self.register_buffer("std", torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1) * 255)

    def forward(self, x):
        return torch.softmax(self.net((x - self.mean) / self.std), dim=1)


def load_model(weights):
    net = MobileNetV3Large(len(LABELS))
    state = torch.load(weights, map_location="cpu", weights_only=False)
    if not isinstance(state, dict):
        state = state.state_dict()
    net.load_state_dict(state, strict=True)
    return Deployable(net).eval()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    model = load_model(args.weights)
    print("Parameters:", sum(p.numel() for p in model.parameters()))
    torch.onnx.export(model, torch.rand(1, 3, 224, 224) * 255, args.out, input_names=["image"],
                      output_names=["probabilities"], opset_version=13, dynamo=False)
    print("Saved", args.out)


if __name__ == "__main__":
    main()
