#!/bin/bash
# The Operator's recording of the video-comments feature (assets/video-edit-coral.mp4) as a clip of the film: padded to 16:9 on the film's dark background, 30 fps, with the caption band laid over it.
# usage: DEMO_ROOT=... prep-edit.sh <recording.mp4> "<caption>"   -> $DEMO_ROOT/work/clips/edit/clip.mp4
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
FF="$S/bin/ffmpeg"; [ -x "$FF" ] || FF=ffmpeg
D="$S/work/clips/edit"; mkdir -p "$D"
node "$HERE/caption-png.mjs" "$2" "$D/cap.png" || exit 1
"$FF" -y -loglevel error -i "$1" -i "$D/cap.png" -filter_complex "[0:v]fps=30,scale=1920:-2:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0e1116,format=yuv420p[a];[a][1:v]overlay=0:0:format=auto,format=yuv420p[o]" -map "[o]" -c:v libx264 -preset veryfast -crf 14 -an "$D/clip.mp4"
echo "$D/clip.mp4"
