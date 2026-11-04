#!/bin/bash
# Encode the v4 takes (work/clips/c1..c10 and the ending) into $DEMO_ROOT/out: the 16:9 master with a short cross-fade between beats
# (a hard cut flashes: dark dialogs and page loads change the frame's brightness at once), the Inbox GIF and the poster.
# usage: encode4.sh   (ENDING=card for the plain end card, else the live public page clip work/clips/hub)
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
FF="$S/bin/ffmpeg"; [ -x "$FF" ] || FF=ffmpeg
C="$S/work/clips"; O="$S/out"; mkdir -p "$O"
g() { ls -t "$C/$1"/*.webm | head -1; }   # the newest take of a beat
FADE=0.5
# speed-ups per beat (the slow waits are compressed; the review page says so); 1.0 = real time
sp() { case $1 in c1) echo 1.3;; c2|c3|c6) echo 1.2;; c4|c5|c8) echo 1.4;; c9) echo 1.3;; c7) echo 1.6;; *) echo 1.0;; esac; }   # (macOS bash has no associative arrays)
LAST=hub; [ "$ENDING" = card ] && LAST=endcard
BEATS=(c1 c2 c3 c4 c5 c6 c7 c9 c10 $LAST)   # (c8, the docked diff, is out: the diff is shown once, by Expand all in c3)
dur() { "$FF" -hide_banner -i "$(g $1)" 2>&1 | python3 -I -c "import re,sys;m=re.search(r'Duration: (\d+):(\d+):([\d.]+)',sys.stdin.read());print(int(m[1])*3600+int(m[2])*60+float(m[3]))"; }
ARGS=(); FC=""; DURS=(); i=0
for n in "${BEATS[@]}"; do
  ARGS+=(-i "$(g $n)"); SPN=$(sp $n); d=$(python3 -I -c "print(round($(dur $n)/$SPN,3))"); DURS+=($d)
  FC+="[$i:v]fps=30,setpts=PTS/$SPN,scale=1600:900,setsar=1,format=yuv420p[v$i];"; i=$((i+1))
done
# xfade chain: the k-th join starts at (sum of the first k+1 lengths) - (k+1)*FADE
OFFS=$(python3 -I -c "
d=[float(x) for x in '${DURS[*]}'.split()]; F=$FADE; s=0; o=[]
for k in range(len(d)-1):
    s+=d[k]; o.append(round(s-(k+1)*F,3))
print(' '.join(map(str,o)))")
read -ra O_ARR <<< "$OFFS"
prev="v0"
for k in $(seq 0 $((${#BEATS[@]}-2))); do
  nxt="x$k"; FC+="[$prev][v$((k+1))]xfade=transition=fade:duration=$FADE:offset=${O_ARR[$k]}[$nxt];"; prev=$nxt
done
FC=${FC%;}
"$FF" -y -loglevel error "${ARGS[@]}" -filter_complex "$FC" -map "[$prev]" -threads 2 -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -movflags +faststart -an "$O/coral-demo-v4-16x9-${LAST}.mp4"
# the GIF: the document review (c7) of the master, where its fade-in starts and for its own length
GS=${O_ARR[5]}; GL=${DURS[6]}
"$FF" -y -loglevel error -ss "$GS" -t "$GL" -i "$O/coral-demo-v4-16x9-${LAST}.mp4" -vf "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" -loop 0 "$O/coral-demo-v4-inbox.gif"
"$FF" -y -loglevel error -ss "$GS" -i "$O/coral-demo-v4-16x9-${LAST}.mp4" -frames:v 1 "$O/coral-demo-v4-poster.png"
echo "beats: ${BEATS[*]}"; echo "lengths: ${DURS[*]}"
echo "wrote $O: $(ls -la "$O" | grep v4 | awk '{print $9" "$5}' | tr '\n' ' ')"
