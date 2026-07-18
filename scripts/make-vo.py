# Generate a NATURAL neural voiceover (edge-tts) per scene for the Tukar demo video.
# Writes build-video/vo<i>.mp3 + build-video/vo.json ([{i,file,ms,text}]).
import asyncio, subprocess, json, os, re
import edge_tts
import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
VOICE = "en-US-AriaNeural"   # natural neural voice (warm, conversational)
RATE = "+6%"                 # a touch quicker so it feels lively, still natural
OUT = "build-video"
os.makedirs(OUT, exist_ok=True)

# One line per demo scene — conversational, not read-aloud-stiff.
LINES = [
    "Stellar exists to move real money across borders. Tukar makes that money private in the middle, and accountable at the edges.",
    "A sender pays five hundred USDC into a corridor bound for Mexico. The amount and the recipient stay hidden on-chain.",
    "In the browser, Tukar builds zero-knowledge compliance and amount proofs, then deposits real testnet USDC into the pool.",
    "On the public ledger you only see a commitment. That count is read live from the contract — real USDC just moved into custody, no mocks.",
    "On the receiving side it arrives shielded. Only at the off-ramp is the amount revealed — about eight thousand seven hundred pesos, at a rate the pool reads on-chain from Reflector.",
    "The receiver withdraws on-chain. The note's nullifier is spent, and the tokens are released.",
    "For an audit, the holder proves just one fact — the amount — and nothing else. The same proof is verified by the live Stellar contract.",
    "And a false claim can't pass. Tamper with the amount, and it's rejected — on-chain.",
    "Private in the middle, compliant at the edges. Real zero-knowledge, live on Stellar. That's Tukar.",
]

def dur_ms(f):
    r = subprocess.run([FFMPEG, "-i", f], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", r.stderr)
    h, mn, s = m.groups()
    return int((int(h) * 3600 + int(mn) * 60 + float(s)) * 1000)

async def main():
    meta = []
    for i, t in enumerate(LINES):
        f = f"{OUT}/vo{i}.mp3"
        await edge_tts.Communicate(t, VOICE, rate=RATE).save(f)
        ms = dur_ms(f)
        meta.append({"i": i, "file": f, "ms": ms, "text": t})
        print(f"  vo{i}: {ms:5d} ms  \"{t[:52]}...\"")
    json.dump(meta, open(f"{OUT}/vo.json", "w"))
    total = sum(m["ms"] for m in meta)
    print(f"\n{len(meta)} scenes, ~{total/1000:.0f}s of natural VO -> {OUT}/vo.json")

asyncio.run(main())
