#!/bin/bash
# Encode the takes in $DEMO_ROOT/work/clips into the three deliverables in $DEMO_ROOT/out:
# the 16:9 master, the 9:16 phone cut and the Inbox GIF. Needs ffmpeg (libx264) at $DEMO_ROOT/bin/ffmpeg or on PATH.
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
FF="$S/bin/ffmpeg"; [ -x "$FF" ] || FF=ffmpeg
C="$S/work/clips"; O="$S/out"; mkdir -p "$O"
g() { ls "$C/$1"/*.webm | head -1; }
# ENDING=card uses work/clips/endcard (node endcard.mjs) in place of work/clips/hub (node hubclip.mjs)
# speed-ups per beat: the slow waits are compressed (the review page says so); 1.0 = real time
SP_b1=1.0; SP_b2=1.2; SP_b3=1.4; SP_b4=1.9; SP_b5=1.4; SP_b6=1.0; SP_b7=1.0; SP_hub=1.0; SP_endcard=1.0
chain() { n=$1; mob=$2; sp=$(eval echo \$SP_$n)
  if [ "$mob" = 1 ]; then echo "fps=30,setpts=PTS/$sp,scale=-2:860,pad=1600:900:(ow-iw)/2:20:0x0e1116,setsar=1"   # the phone, centred
  else echo "fps=30,setpts=PTS/$sp,scale=1600:900,setsar=1"; fi; }
ARGS=(); FC=""; i=0
LAST=hub; [ "$ENDING" = card ] && LAST=endcard   # ENDING=card: the plain end card instead of the live public page
for n in b1 b2 b3 b4 b5 b6 b7 $LAST; do ARGS+=(-i "$(g $n)"); m=0; [ $n = b6 ] && m=1; FC+="[$i:v]$(chain $n $m)[v$i];"; i=$((i+1)); done
FC+="[v0][v1][v2][v3][v4][v5][v6][v7]concat=n=8:v=1:a=0[out]"
"$FF" -y -loglevel error "${ARGS[@]}" -filter_complex "$FC" -map "[out]" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -an "$O/coral-demo-16x9.mp4"
"$FF" -y -loglevel error -i "$(g b6)" -vf "fps=30,scale=-2:1920:flags=lanczos,pad=1080:1920:(ow-iw)/2:0:0x0e1116,setsar=1" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -an "$O/coral-demo-9x16-phone.mp4"
# the GIF: the Inbox review (beat 4) of the master. Its start is where beat 4 begins in the master (the sped-up lengths of beats 1 to 3), its length beat 4's own.
dur() { "$FF" -hide_banner -i "$(g $1)" 2>&1 | python3 -I -c "import re,sys;m=re.search(r'Duration: (\d+):(\d+):([\d.]+)',sys.stdin.read());print(int(m[1])*3600+int(m[2])*60+float(m[3]))"; }
START=$(python3 -I -c "print(sum(float(d)/s for d,s in [('$(dur b1)',$SP_b1),('$(dur b2)',$SP_b2),('$(dur b3)',$SP_b3)]))")
LEN=$(python3 -I -c "print(float('$(dur b4)')/$SP_b4)")
"$FF" -y -loglevel error -ss "$START" -t "$LEN" -i "$O/coral-demo-16x9.mp4" -vf "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" -loop 0 "$O/coral-demo-inbox.gif"
echo "wrote $O: $(ls -la "$O" | awk 'NR>3{print $9" "$5}' | tr '\n' ' ')"
