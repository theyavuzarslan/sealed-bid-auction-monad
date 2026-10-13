"""Score for promo/film (30 s, 120 BPM, D minor lifting to F major), synthesized with numpy.

Cues follow the picture in index.html: clock ticks under "Every token launch is a race", a driving
pulse under the mempool, a stutter and a half second of silence, a soft pad under the question, a hit
on the coin at 10.0 s, a groove through seal / reveal / clear with pops on every on-screen event, a
lift on "One price. For everyone.", and a held chord on the end card.

    python3 promo/film/score.py [out.wav]
"""
import sys
import wave

import numpy as np

SR = 48_000
DUR = 30.0
N = int(SR * DUR)
BEAT = 0.5
rng = np.random.default_rng(7)
L = np.zeros(N)
R = np.zeros(N)


def t_arr(d):
    return np.arange(int(SR * d)) / SR


def add(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * np.sqrt((1 - pan) / 2) * 1.4142
    R[i:i + len(sig)] += sig * np.sqrt((1 + pan) / 2) * 1.4142


def lowpass(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for k in range(len(x)):
        acc = (1 - a) * x[k] + a * acc
        y[k] = acc
    return y


def env(n, a, d, s=0.0, r=0.05, hold=None):
    """ADSR over n samples (seconds for a, d, r)."""
    e = np.full(n, float(s))
    na, nd, nr = int(a * SR), int(d * SR), int(r * SR)
    e[:na] = np.linspace(0, 1, na, endpoint=False) if na else e[:na]
    e[na:na + nd] = np.linspace(1, s, max(nd, 1))[: len(e[na:na + nd])]
    if nr:
        e[-nr:] *= np.linspace(1, 0, nr)
    return e


def hz(note):
    return 440.0 * 2 ** ((note - 69) / 12)


# ── Instruments ─────────────────────────────────────────────────────

def tick(high=True):
    t = t_arr(0.05)
    f = 2400 if high else 1600
    return np.sin(2 * np.pi * f * t) * np.exp(-t * 140) + rng.normal(0, 1, len(t)) * np.exp(-t * 400) * 0.3


def kick(punch=1.0):
    t = t_arr(0.45)
    f = 45 + 110 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.tanh(np.sin(ph) * np.exp(-t * 7) * 1.8 * punch)


def snare():
    t = t_arr(0.25)
    n = rng.normal(0, 1, len(t))
    body = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30)
    return (n - lowpass(n, 1500)) * np.exp(-t * 18) * 0.7 + body * 0.4


def hat(open_=False):
    t = t_arr(0.18 if open_ else 0.05)
    n = rng.normal(0, 1, len(t))
    return (n - lowpass(n, 7000)) * np.exp(-t * (14 if open_ else 90)) * 0.5


def pad(notes, d, cutoff=1800, attack=0.6, release=0.8):
    t = t_arr(d)
    s = np.zeros_like(t)
    for m in notes:
        for det in (-0.12, 0.0, 0.11):
            f = hz(m + det)
            s += 2 * ((t * f) % 1.0) - 1
    s = lowpass(s / (len(notes) * 3), cutoff)
    return s * env(len(t), attack, 0.4, 0.85, release)


def bass(m, d):
    t = t_arr(d)
    f = hz(m)
    s = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t)
    return np.tanh(s * 1.6) * env(len(t), 0.005, 0.15, 0.7, 0.06)


def pluck(m, d=0.6, bright=1.0):
    t = t_arr(d)
    f = hz(m)
    s = sum(np.sin(2 * np.pi * f * k * t) * np.exp(-t * (6 + 5 * k)) / k for k in (1, 2, 3, 4))
    return s * bright * env(len(t), 0.002, d, 0, 0.02)


def pop(m):
    t = t_arr(0.12)
    f = hz(m) * (1 + 0.6 * np.exp(-t * 60))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 35)


def riser(d, f0=200, f1=2400):
    t = t_arr(d)
    n = rng.normal(0, 1, len(t))
    out = np.zeros_like(n)
    seg = 2048
    for k in range(0, len(n), seg):
        c = f0 * (f1 / f0) ** (k / len(n))
        out[k:k + seg] = n[k:k + seg] - lowpass(n[k:k + seg], c)
    return out * np.linspace(0, 1, len(t)) ** 2 * 0.5


def boom():
    t = t_arr(2.4)
    f = 32 + 60 * np.exp(-t * 6)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.6)
    n = rng.normal(0, 1, len(t))
    crash = (n - lowpass(n, 3000)) * np.exp(-t * 2.2) * 0.35
    return np.tanh(sub * 2.0) + crash


# ── Arrangement ────────────────────────────────────────────────────
D2, F2, A2, Bb1, C2 = 38, 41, 45, 34, 36
Dm, Bb, F, C = [62, 65, 69], [58, 62, 65], [60, 65, 69], [60, 64, 67]

# 0–4: the clock, over a low drone that swells
for k in range(8):
    add(tick(k % 2 == 0), 0.25 + k * BEAT, 0.5)
add(pad([D2 + 12, A2 + 12], 4.0, cutoff=500, attack=2.5, release=0.3), 0.0, 0.5)
add(riser(0.45, 400, 6000), 2.95, 0.5)                          # the strike-through

# 4–7.6: the mempool pulse, rising
for k in range(7):
    at = 4.0 + k * BEAT
    add(kick(0.9), at, 0.8)
    add(bass(D2, 0.22), at, 0.45)
    add(bass(D2, 0.2), at + 0.25, 0.3)
for k in range(28):
    add(hat(), 4.0 + k * 0.125, 0.35 if k % 2 else 0.6, pan=0.3 if k % 2 else -0.3)
add(riser(3.4, 150, 3000), 4.1, 0.6)
for k in range(10):                                             # stutter
    add(tick(True) * 1.5, 7.1 + k * 0.05, 0.5)
# 7.6–8.0: silence

# 8–10: the question, a soft chord and a reversed swell into the hit
add(pad(Bb, 2.0, cutoff=1200, attack=0.4, release=0.4), 8.0, 0.45)
add(riser(1.0, 300, 8000), 9.0, 0.7)

# 10: the coin
add(boom(), 10.0, 0.9)
add(pad([50] + Dm, 2.6, cutoff=3200, attack=0.01, release=1.2), 10.0, 0.6)
add(pluck(74, 1.2), 10.45, 0.5, pan=0.2)
add(pluck(81, 1.2), 10.6, 0.35, pan=-0.2)

# 12.5–22.5: the groove (two-bar chord cycle Dm Bb F C)
prog = [(Dm, D2), (Bb, Bb1), (F, F2), (C, C2)]
t0 = 12.5
k = 0
while t0 + k * 2 < 22.5:
    ch, b = prog[k % 4]
    bar = t0 + k * 2
    add(pad(ch, 2.0, cutoff=1600), bar, 0.32)
    for q in range(4):
        at = bar + q * BEAT
        if at >= 22.5:
            break
        add(kick(), at, 0.75 if q % 2 == 0 else 0.5)
        if q % 2:
            add(snare(), at, 0.45)
        add(bass(b, 0.2), at, 0.42)
        add(bass(b + 12 if q == 3 else b, 0.18), at + 0.25, 0.28)
        add(hat(), at + 0.25, 0.3, pan=0.25)
    k += 1

# events in the seal scene
add(pluck(69, 0.3), 14.2, 0.55)                                  # the button press
for i in range(12):
    add(tick(i % 2 == 0) * 0.6, 14.4 + i * 0.05, 0.35, pan=0.4)  # the hash typing
for i in range(8):
    add(pop(74 + [0, 3, 5, 7, 10, 12, 15, 17][i]), 15.0 + i * 0.12, 0.35, pan=-0.6 + i * 0.17)
# reveal: a pop per bar, rising; supply line; the price line sweep and its hit
for i in range(8):
    add(pop(62 + [0, 2, 3, 5, 7, 8, 10, 12][i]), 17.5 + i * 0.22, 0.4, pan=-0.5 + i * 0.14)
add(pluck(57, 0.5), 19.6, 0.5)
add(riser(0.8, 300, 5000), 20.2, 0.5)
add(pluck(81, 1.0, 1.2), 21.0, 0.5)
add(pluck(77, 1.0), 21.0, 0.35)

# 22.5–25: the lift to F major
add(boom() * 0.5, 22.5, 0.6)
add(pad([53] + F + [72], 2.5, cutoff=4000, attack=0.05, release=0.6), 22.5, 0.5)
for i, m in enumerate([77, 81, 84, 89]):
    add(pluck(m, 0.8), 23.2 + i * 0.125, 0.3, pan=-0.3 + i * 0.2)
for q in range(5):
    add(kick(0.7), 22.5 + q * BEAT, 0.5)

# 25–27.5: proof, a pop per number
add(pad(C + [72], 2.5, cutoff=2400), 25.0, 0.35)
for i, at in enumerate((25.3, 25.6, 25.9)):
    add(pop(79 + i * 3), at, 0.55)
    add(kick(0.6), at, 0.35)

# 27.5–30: the end card, one held chord
add(boom() * 0.6, 27.5, 0.6)
add(pad([38, 50] + Dm + [74], 2.5, cutoff=2600, attack=0.02, release=1.4), 27.5, 0.55)
add(pluck(74, 2.0), 27.6, 0.4)
add(pluck(81, 2.0), 28.3, 0.3, pan=0.3)

# ── Master: gentle glue, fade out, peak to -1 dBFS ─────────────────
mix = np.stack([L, R])
mix = np.tanh(mix * 0.9) / 0.9
fade = np.ones(N)
fade[int(29.4 * SR):] = np.linspace(1, 0, N - int(29.4 * SR)) ** 1.5
mix *= fade
mix *= 10 ** (-1 / 20) / np.max(np.abs(mix))
out = sys.argv[1] if len(sys.argv) > 1 else "film-audio.wav"
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix.T * 32767).astype("<i2").tobytes())
print("wrote", out)
