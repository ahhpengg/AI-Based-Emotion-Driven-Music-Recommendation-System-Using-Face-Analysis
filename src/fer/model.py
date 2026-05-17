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

    Input contract: float32 images in [0, 255] range, shape (300, 300, 3).
    Preprocessing to [-1, 1] is embedded inside the model via the Rescaling layer,
    so no external preprocessing is needed at inference time.
    """
    inputs = layers.Input(shape=INPUT_SHAPE, name="image")

    # Augmentation block — active only when training=True, no-op at inference.
    # Operates on [0, 255] images, matching the default value_range for RandomBrightness.
    x = layers.RandomFlip("horizontal")(inputs)
    x = layers.RandomRotation(0.028)(x)    # ±10 degrees
    x = layers.RandomZoom(0.1)(x)
    x = layers.RandomBrightness(0.1)(x)

    # Scale [0, 255] → [-1, 1] as EfficientNet expects.
    # Equivalent to tf.keras.applications.efficientnet.preprocess_input but serialisation-safe.
    x = layers.Rescaling(scale=1 / 127.5, offset=-1.0, name="efficientnet_preprocess")(x)

    backbone = tf.keras.applications.EfficientNetB3(
        include_top=False,
        weights="imagenet",
        input_tensor=x,
        pooling=None,
    )
    backbone.trainable = False

    x = layers.GlobalAveragePooling2D(name="gap")(backbone.output)
    x = layers.Dropout(dropout, name="head_dropout")(x)
    outputs = layers.Dense(NUM_CLASSES, activation="softmax", name="emotion_softmax")(x)

    model = Model(inputs=inputs, outputs=outputs, name="emotion_efficientnetb3")
    return model, backbone


def unfreeze_top_blocks(backbone: Model) -> None:
    """Unfreeze block6 and block7 of EfficientNetB3 for Phase 2 fine-tuning.

    BatchNormalization layers remain frozen throughout to preserve the pretrained
    running statistics — updating BN stats on a small dataset corrupts them.
    Call model.compile() again after this with the lower Phase 2 learning rate.
    """
    unfreeze = False
    for layer in backbone.layers:
        if "block6a_expand_conv" in layer.name:
            unfreeze = True
        if unfreeze:
            layer.trainable = not isinstance(layer, layers.BatchNormalization)
