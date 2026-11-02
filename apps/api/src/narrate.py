"""Local neural narration; frame-aligned scene durations drive both cuts and captions."""
import json
import math
import os
import sys
import wave
import re
from pathlib import Path
from piper import PiperVoice, SynthesisConfig

plan_path = Path(sys.argv[1])
scenes = json.loads(plan_path.read_text())
voice_id = sys.argv[2] if len(sys.argv) > 2 else "irina"
if not re.fullmatch(r"(irina|dmitri|denis)", voice_id):
    voice_id = "irina"
model_path = os.environ.get("PIPER_MODEL", f"/opt/voices/ru_RU-{voice_id}-medium.onnx")
voice = PiperVoice.load(model_path)
sample_rate = voice.config.sample_rate
output = plan_path.parent / "narration.wav"
with wave.open(str(output), "wb") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(sample_rate)
    for scene in scenes:
        # One clause per utterance, never individual words. Display exactly this
        # clause for the measured audio span rather than estimating reading speed.
        audio = b"".join(chunk.audio_int16_bytes for chunk in voice.synthesize(
            scene["text"], syn_config=SynthesisConfig(length_scale=1.0, noise_scale=0.667, noise_w_scale=0.8)
        ))
        samples = len(audio) // 2
        frames = max(1, math.ceil(samples / sample_rate * 30))
        target_samples = round(frames / 30 * sample_rate)
        wav.writeframes(audio + b"\0\0" * max(0, target_samples - samples))
        scene["duration"] = frames / 30
        scene["frames"] = frames
plan_path.write_text(json.dumps(scenes, ensure_ascii=False, indent=2))
print(json.dumps({"voice": f"ru_RU-{voice_id}-medium", "scenes": len(scenes), "output": str(output)}))
