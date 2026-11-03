#!/bin/bash
# Encode the takes in $DEMO_ROOT/work/clips into the three deliverables in $DEMO_ROOT/out:
# the 16:9 master, the 9:16 phone cut and the Inbox GIF. Needs ffmpeg (libx264) at $DEMO_ROOT/bin/ffmpeg or on PATH.
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
FF="$S/bin/ffmpeg"; [ -x "$FF" ] || FF=ffmpeg
C="$S/work/clips"; O="$S/out"; mkdir -p "$O"
g() { ls "$C/$1"/*.webm | head -1; }
# speed-ups per beat: the slow waits are compressed (the review page says so); 1.0 = real time
SP_b1=1.0; SP_b2=1.2; SP_b3=1.4; SP_b4=1.9; SP_b5=1.4; SP_b6=1.0; SP_b7=1.0; SP_hub=1.0
chain() { n=$1; mob=$2; sp=$(eval echo \$SP_$n)
  if [ "$mob" = 1 ]; then echo "fps=30,setpts=PTS/$sp,scale=-2:860,pad=1600:900:(ow-iw)/2:20:0x0e1116,setsar=1"   # the phone, centred
  else echo "fps=30,setpts=PTS/$sp,scale=1600:900,setsar=1"; fi; }
ARGS=(); FC=""; i=0
for n in b1 b2 b3 b4 b5 b6 b7 hub; do ARGS+=(-i "$(g $n)"); m=0; [ $n = b6 ] && m=1; FC+="[$i:v]$(chain $n $m)[v$i];"; i=$((i+1)); done
FC+="[v0][v1][v2][v3][v4][v5][v6][v7]concat=n=8:v=1:a=0[out]"
"$FF" -y -loglevel error "${ARGS[@]}" -filter_complex "$FC" -map "[out]" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -an "$O/coral-demo-16x9.mp4"
"$FF" -y -loglevel error -i "$(g b6)" -vf "fps=30,scale=-2:1920:flags=lanczos,pad=1080:1920:(ow-iw)/2:0:0x0e1116,setsar=1" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -an "$O/coral-demo-9x16-phone.mp4"
# the GIF: the Inbox review (beat 4) of the master; the start and length follow the speed-ups above (33 s in, 23.6 s long)
"$FF" -y -loglevel error -ss 33 -t 23.6 -i "$O/coral-demo-16x9.mp4" -vf "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" -loop 0 "$O/coral-demo-inbox.gif"
echo "wrote $O: $(ls -la "$O" | awk 'NR>3{print $9" "$5}' | tr '\n' ' ')"
