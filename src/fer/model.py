"""EfficientNet-B3 emotion classification model definition."""

import tensorflow as tf
from tensorflow.keras import layers, Model

NUM_CLASSES = 7
INPUT_SHAPE = (300, 300, 3)

# Fixed label order matches RAF-DB folder indices 1–7 mapped to 0–6.
EMOTION_LABELS = ["surprise", "fear", "disgust", "happy", "sad", "angry", "neutral"]
IN_SCOPE = {"surprise", "happy", "sad", "angry", "neutral"}


@tf.keras.saving.register_keras_serializable(package="fer")
class CBAM(layers.Layer):
    """Convolutional Block Attention Module (Woo et al., 2018).

    Applies channel attention (shared MLP over avg- and max-pooled features) followed
    by spatial attention (7x7 conv over channel-wise mean and max maps). Each sub-module
    multiplies the input by a sigmoid-activated attention mask, so the layer is a
    no-op at initialisation if the masks saturate to 1.
    """

    def __init__(self, reduction_ratio: int = 16, spatial_kernel_size: int = 7, **kwargs):
        super().__init__(**kwargs)
        self.reduction_ratio = reduction_ratio
        self.spatial_kernel_size = spatial_kernel_size

    def build(self, input_shape):
        channels = int(input_shape[-1])
        hidden = max(channels // self.reduction_ratio, 1)
        self.mlp_hidden = layers.Dense(hidden, activation="relu", name="channel_mlp_hidden")
        self.mlp_output = layers.Dense(channels, name="channel_mlp_output")
        self.spatial_conv = layers.Conv2D(
            filters=1,
            kernel_size=self.spatial_kernel_size,
            padding="same",
            activation="sigmoid",
            use_bias=False,
            name="spatial_conv",
        )
        super().build(input_shape)

    def call(self, x):
        # Channel attention — shared MLP over avg-pooled and max-pooled descriptors.
        avg = tf.reduce_mean(x, axis=[1, 2], keepdims=True)
        mx = tf.reduce_max(x, axis=[1, 2], keepdims=True)
        channel_att = tf.nn.sigmoid(
            self.mlp_output(self.mlp_hidden(avg)) + self.mlp_output(self.mlp_hidden(mx))
        )
        x = x * channel_att

        # Spatial attention — channel-wise pooled maps fed through a single conv.
        avg_s = tf.reduce_mean(x, axis=-1, keepdims=True)
        max_s = tf.reduce_max(x, axis=-1, keepdims=True)
        spatial_att = self.spatial_conv(tf.concat([avg_s, max_s], axis=-1))
        return x * spatial_att

    def get_config(self):
        config = super().get_config()
        config.update({
            "reduction_ratio": self.reduction_ratio,
            "spatial_kernel_size": self.spatial_kernel_size,
        })
        return config


def build_model(dropout: float = 0.3) -> tuple[Model, Model]:
    """Build the EfficientNet-B3 emotion classifier in Phase 1 config (backbone frozen).

    Returns (full_model, backbone). Pass backbone to unfreeze_top_blocks() before
    Phase 2 training.

    Compatible with TF 2.20 / Keras 3. EfficientNetB3 handles preprocessing
    internally — input must be float32 in [0, 255], no external scaling needed.
    """
    # Build backbone with input_shape (Keras 3 compatible; avoids input_tensor issues).
    backbone = tf.keras.applications.EfficientNetB3(
        include_top=False,
        weights="imagenet",
        input_shape=INPUT_SHAPE,
        pooling=None,
    )
    backbone.trainable = False

    inputs = layers.Input(shape=INPUT_SHAPE, name="image")

    # Augmentation — active only when training=True, no-op at inference.
    # Operates on [0, 255] images; value_range default matches this.
    x = layers.RandomFlip("horizontal")(inputs)
    x = layers.RandomRotation(0.028)(x)    # ±10 degrees
    x = layers.RandomZoom(0.1)(x)
    x = layers.RandomBrightness(0.1)(x)

    # Call backbone with training=False to keep BatchNorm in inference mode
    # throughout both phases. Unfrozen conv weights still receive gradients
    # because training=False only affects BN/Dropout behaviour, not gradient flow.
    x = backbone(x, training=False)

    # Channel + spatial attention over the (10, 10, 1536) backbone feature map.
    x = CBAM(reduction_ratio=16, spatial_kernel_size=7, name="cbam")(x)

    x = layers.GlobalAveragePooling2D(name="gap")(x)
    x = layers.Dropout(dropout, name="head_dropout")(x)
    outputs = layers.Dense(NUM_CLASSES, activation="softmax", name="emotion_softmax")(x)

    model = Model(inputs=inputs, outputs=outputs, name="emotion_efficientnetb3")
    return model, backbone


def unfreeze_top_blocks(backbone: Model) -> None:
    """Unfreeze block5, block6 and block7 of EfficientNetB3 for Phase 2 fine-tuning.

    BatchNormalization layers stay frozen (trainable=False) so their gamma/beta
    parameters do not receive gradient updates. BN running stats are also frozen
    because the backbone is always called with training=False.
    Call model.compile() again after this with the Phase 2 learning rate.
    """
    unfreeze = False
    for layer in backbone.layers:
        if "block5a_expand_conv" in layer.name:
            unfreeze = True
        if unfreeze:
            layer.trainable = not isinstance(layer, layers.BatchNormalization)
