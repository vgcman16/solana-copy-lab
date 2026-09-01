import argparse
import glob
import os
import shutil
from PIL import Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("frames")
    parser.add_argument("output")
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--loop", type=int, default=0)
    parser.add_argument("--cleanup", action="store_true")
    args = parser.parse_args()

    files = sorted(glob.glob(os.path.join(args.frames, "frame_*.png")))
    if not files:
        raise RuntimeError(f"No rendered frames were found in {args.frames}")

    frames = []
    for path in files:
        with Image.open(path) as image:
            frames.append(image.convert("RGBA"))
    frames[0].save(
        args.output,
        format="WEBP",
        save_all=True,
        append_images=frames[1:],
        duration=round(1000 / max(1, args.fps)),
        loop=args.loop,
        quality=100,
        method=5,
        minimize_size=False,
        allow_mixed=False,
        lossless=True,
        alpha_quality=100,
        background=(0, 0, 0, 0),
    )
    for frame in frames:
        frame.close()
    if args.cleanup:
        shutil.rmtree(args.frames)
    print(args.output)


if __name__ == "__main__":
    main()
