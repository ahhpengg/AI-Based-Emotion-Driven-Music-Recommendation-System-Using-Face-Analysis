"""EfficientNet-B3 emotion classification model definition."""

import tensorflow as tf
from tensorflow.keras import layers, Model

NUM_CLASSES = 7
INPUT_SHAPE = (300, 300, 3)

# Fixed label order matches RAF-DB folder indices 1–7 mapped to 0–6.
EMOTION_LABELS = ["surprise", "fear", "disgust", "happy", "sad", "angry", "neutral"]
IN_SCOPE = {"surprise", "happy", "sad", "angry", "neutral"}


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

    x = layers.GlobalAveragePooling2D(name="gap")(x)
    x = layers.Dropout(dropout, name="head_dropout")(x)
    outputs = layers.Dense(NUM_CLASSES, activation="softmax", name="emotion_softmax")(x)

    model = Model(inputs=inputs, outputs=outputs, name="emotion_efficientnetb3")
    return model, backbone


def unfreeze_top_blocks(backbone: Model) -> None:
    """Unfreeze block6 and block7 of EfficientNetB3 for Phase 2 fine-tuning.

    BatchNormalization layers stay frozen (trainable=False) so their gamma/beta
    parameters do not receive gradient updates. BN running stats are also frozen
    because the backbone is always called with training=False.
    Call model.compile() again after this with the Phase 2 learning rate.
    """
    unfreeze = False
    for layer in backbone.layers:
        if "block6a_expand_conv" in layer.name:
            unfreeze = True
        if unfreeze:
            layer.trainable = not isinstance(layer, layers.BatchNormalization)
