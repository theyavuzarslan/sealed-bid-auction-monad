#!/usr/bin/env python3
"""Soundtrack for the 45 s "Even" pixel-art commercial.

Original chiptune score + SFX, synthesised with numpy only and written with the
`wave` module. Reads the shared clock in timeline.json (same directory) and
places every SFX at its exact event time; music bar grids are anchored on the
key events (13.4 stamp, 21.2 lights_out, 34.6 stamp_draw, 41.7 logo).

Usage:  python3 audio.py            -> audio.wav (+ stems/music.wav, stems/sfx.wav,
        pre-limiter and 6 dB down)
        python3 audio.py --cut 30   -> audio-30.wav (v3 30 s master; arrangement,
        SFX placement and mix in score30.py, clock in timeline-30.json)

Mix: music bus at -18 dBFS RMS over its active parts, SFX on top, soft-knee
limiter, peak normalised to -1 dBFS, 50 ms fade-in. Deterministic (seeded noise).

Key arc: D major (attract) -> D minor (bonding-curve race, the unfair one) ->
silence (sealed) -> rising build on the dominant -> D major on DRAW.
"""
import json
import os
import wave

import numpy as np

SR = 44100
DUR = 45.0
N = int(round(DUR * SR))  # 1,984,500 frames
HERE = os.path.dirname(os.path.abspath(__file__))
RNG = np.random.default_rng(13)

# ---------------------------------------------------------------- instruments


def mtof(m):
    return 440.0 * 2.0 ** ((np.asarray(m, dtype=float) - 69.0) / 12.0)


def _blep(t, dt):
    """PolyBLEP residual for a unit-step discontinuity at phase 0."""
    out = np.zeros_like(t)
    a = t < dt
    x = t[a] / dt[a]
    out[a] = x + x - x * x - 1.0
    b = t > 1.0 - dt
    x = (t[b] - 1.0) / dt[b]
    out[b] = x * x + x + x + 1.0
    return out


def phase_of(freq):
    """Cumulative phase (cycles) for a per-sample frequency array."""
    inc = freq / SR
    return np.cumsum(inc) - inc[0], inc


def pulse(freq, duty=0.5):
    """Band-limited pulse (PolyBLEP), DC removed so asymmetric duties don't thump."""
    ph, dt = phase_of(freq)
    p1 = ph % 1.0
    p2 = (ph + (1.0 - duty)) % 1.0
    saw1 = 2.0 * p1 - 1.0 - _blep(p1, dt)
    saw2 = 2.0 * p2 - 1.0 - _blep(p2, dt)
    y = 0.5 * (saw1 - saw2)
    return y - y.mean() if len(y) else y


def triangle(freq, steps=16):
    """NES-flavoured stepped triangle (quantised to `steps` levels)."""
    ph, _ = phase_of(freq)
    p = ph % 1.0
    tri = 1.0 - 4.0 * np.abs(p - 0.5)
    if steps:
        tri = np.round((tri + 1.0) * 0.5 * (steps - 1)) / (steps - 1) * 2.0 - 1.0
    return tri - tri.mean() if len(tri) else tri


def sine(freq):
    ph, _ = phase_of(freq)
    return np.sin(2 * np.pi * ph)


def noise(n, color="white"):
    w = RNG.uniform(-1.0, 1.0, n)
    if color == "hi":  # crude high-pass: first difference
        w = np.diff(w, prepend=0.0) * 0.6
    elif color == "lo":  # crude low-pass: moving average
        w = np.convolve(w, np.ones(6) / 6.0, mode="same") * 2.0
    return w


def adsr(n, a=0.004, d=0.06, s=0.6, r=0.02):
    """ADSR over n samples; release fits inside the segment so it ends at zero."""
    env = np.full(n, s, dtype=float)
    na, nd, nr = int(a * SR), int(d * SR), int(r * SR)
    na = max(1, min(na, n // 3))
    nr = max(1, min(nr, n // 3))
    nd = max(0, min(nd, n - na - nr))
    env[:na] = np.linspace(0.0, 1.0, na, endpoint=False)
    if nd:
        env[na:na + nd] = np.linspace(1.0, s, nd, endpoint=False)
    env[n - nr:] *= np.linspace(1.0, 0.0, nr)
    return env


def perc(n, a=0.002, tau=0.05):
    """Fast attack, exponential decay, forced to zero at the end."""
    t = np.arange(n) / SR
    env = np.exp(-t / tau)
    na = max(1, int(a * SR))
    env[:na] *= np.linspace(0.0, 1.0, na)
    nr = max(1, min(int(0.006 * SR), n // 4))
    env[-nr:] *= np.linspace(1.0, 0.0, nr)
    return env


def vib_freq(f0, n, depth_cents=14.0, rate=5.6, delay=0.14):
    """Constant pitch with delayed vibrato (phase-increment modulation)."""
    t = np.arange(n) / SR
    ramp = np.clip((t - delay) / 0.12, 0.0, 1.0)
    cents = depth_cents * ramp * np.sin(2 * np.pi * rate * t)
    return f0 * 2.0 ** (cents / 1200.0)


# ------------------------------------------------------------- buses & notes

BUSES = ["lead", "harm", "arp", "bass", "drums", "sfx"]


def new_buses():
    return {k: np.zeros((N, 2)) for k in BUSES}


B = new_buses()


def add(bus, t, x, pan=0.0, gain=1.0):
    """Mix mono samples x into bus at absolute time t (s). pan -1..1, equal power."""
    i0 = int(round(t * SR))
    if i0 >= N or len(x) == 0:
        return
    if i0 < 0:
        x = x[-i0:]
        i0 = 0
    x = x[: N - i0] * gain
    ang = (pan + 1.0) * np.pi / 4.0
    B[bus][i0:i0 + len(x), 0] += x * np.cos(ang)
    B[bus][i0:i0 + len(x), 1] += x * np.sin(ang)


def nsamp(d):
    return max(8, int(round(d * SR)))


def note(bus, t, d, m, vel=0.5, duty=0.5, pan=0.0, wave_="pulse",
         a=0.004, dcy=0.08, s=0.55, r=0.025, vib=None, slide=0.0):
    """One note. d = sounding length (s). vib: None=auto (on notes >= 0.3 s)."""
    n = nsamp(d)
    f0 = float(mtof(m))
    if vib is None:
        vib = d >= 0.3
    f = vib_freq(f0, n) if vib else np.full(n, f0)
    if slide:  # pitch glide in semitones over the note
        f = f * 2.0 ** (np.linspace(0.0, slide, n) / 12.0)
    if wave_ == "pulse":
        y = pulse(f, duty)
    elif wave_ == "tri":
        y = triangle(f)
    else:
        y = sine(f)
    add(bus, t, y * adsr(n, a, dcy, s, r), pan, vel)


def seq(bus, t0, beat, items, **kw):
    """items: (beat_offset, beats_len, midi, [vel]) relative to t0 on a beat grid.
    Sounding length = 92% of the slot so notes detach cleanly."""
    for it in items:
        off, ln, m = it[0], it[1], it[2]
        vel = it[3] if len(it) > 3 else kw.get("vel", 0.5)
        k = dict(kw)
        k["vel"] = vel
        if m is None:
            continue
        ms = m if isinstance(m, (list, tuple)) else [m]
        for mm in ms:
            note(bus, t0 + off * beat, ln * beat * 0.92, mm, **k)


def times(t0, dt, n):
    return np.round(t0 + dt * np.arange(n), 4)


# drums (noise channel + triangle kick)

def hat(t, vel=0.12, open_=False, pan=0.2):
    n = nsamp(0.16 if open_ else 0.045)
    add("drums", t, noise(n, "hi") * perc(n, 0.001, 0.05 if open_ else 0.012), pan, vel)


def snare(t, vel=0.28):
    n = nsamp(0.16)
    body = triangle(np.full(n, 190.0) * np.linspace(1.15, 0.85, n), 0) * perc(n, 0.001, 0.03)
    add("drums", t, noise(n) * perc(n, 0.001, 0.045) * 0.8 + body * 0.5, 0.0, vel)


def kick(t, vel=0.55):
    n = nsamp(0.14)
    f = 55.0 + 110.0 * np.exp(-np.arange(n) / SR / 0.02)
    add("drums", t, triangle(f, 0) * perc(n, 0.001, 0.06), 0.0, vel)


# chord-tone tables (midi). D major / D minor family
D2, A2, D3 = 38, 45, 50
CH = {
    "D":  [62, 66, 69], "Dm": [62, 65, 69], "Bb": [58, 62, 65], "C": [60, 64, 67],
    "Gm": [55, 58, 62], "A":  [57, 61, 64], "G":  [55, 59, 62], "Bm": [59, 62, 66],
    "Em": [52, 55, 59], "A7": [57, 61, 64, 67], "Asus": [57, 62, 64], "F": [53, 57, 60],
}
ROOT = {"D": 38, "Dm": 38, "Bb": 34, "C": 36, "Gm": 43, "A": 45, "G": 43, "Bm": 47,
        "Em": 40, "A7": 45, "Asus": 45, "F": 41}


def arp(t0, t1, chord, step, oct_=12, vel=0.16, duty=0.25, pan=0.45, pattern=(0, 1, 2, 3)):
    """Right-ish 16th arpeggio over chord tones between t0 and t1."""
    tones = CH[chord] + [CH[chord][0] + 12]
    k = 0
    for t in np.arange(t0, t1 - 1e-6, step):
        m = tones[pattern[k % len(pattern)] % len(tones)] + oct_
        note("arp", float(t), step * 0.8, m, vel, duty, pan, a=0.002, dcy=0.03, s=0.4, r=0.01, vib=False)
        k += 1


def crash(t, vel=0.22, tau=0.35, dur=1.0):
    n = nsamp(dur)
    add("drums", t, noise(n, "hi") * perc(n, 0.001, tau), -0.15, vel)


def bass_run(t0, step, notes_, vel=0.42, frac=0.85):
    """Triangle bass: list of midi (None = rest) on a fixed step."""
    for i, m in enumerate(notes_):
        if m is not None:
            note("bass", t0 + i * step, step * frac, m, vel, wave_="tri",
                 a=0.003, dcy=0.05, s=0.8, r=0.015, vib=False)


# ------------------------------------------------------------------- score
# Each scene's bar grid is anchored backwards from its key event.

def score_attract():
    """0.0-4.0  D major, 120 BPM (beat 0.5): bright 2-bar motif. Bars at 0.0, 2.0."""
    b = 0.5
    lead = [(0, .5, 74), (.5, .5, 78), (1, .5, 81), (1.5, 1, 86),
            (2.5, .5, 85), (3, .5, 83), (3.5, .5, 81),
            (4, .5, 79), (4.5, .5, 83), (5, .5, 86), (5.5, 1, 88),
            (6.5, .25, 85), (6.75, .25, 86), (7, .75, 88)]
    seq("lead", 0.0, b, lead, vel=0.30, duty=0.5, pan=0.0)
    # harmony (left): quarter stabs, thin 12.5 % duty
    for beat, ch in [(0, "D"), (1, "D"), (2, "D"), (3, "D"), (4, "G"), (5, "G"), (6, "A"), (7, "A")]:
        for m in CH[ch]:
            note("harm", beat * b, 0.16, m, 0.07, 0.125, -0.45, a=0.003, dcy=0.05, s=0.5, r=0.02, vib=False)
    roots = [D2] * 4 + [43] * 2 + [45] * 2
    bass_run(0.0, b / 2, [r + (12 if i % 2 else 0) for r in roots for i in range(2)], vel=0.40)
    arp(2.0, 3.0, "G", 0.125, oct_=12, vel=0.10)
    arp(3.0, 3.75, "A", 0.125, oct_=12, vel=0.11)
    for i in range(8):
        hat(i * b + b / 2, 0.09)
        (kick if i % 2 == 0 else snare)(i * b, 0.45 if i % 2 == 0 else 0.20)
    for k, t in enumerate(times(3.75, 0.0625, 4)):  # fill into the race
        snare(float(t), 0.12 + 0.04 * k)


CURVE_T0, CURVE_BEAT = 4.0, (13.4 - 4.0) / 24.0  # 6 bars of ~153 BPM, bar 7 = stamp


def score_curve():
    """4.0-13.4  D minor, ~153 BPM, frantic and building. Downbeat 7 = stamp 13.4."""
    b, t0 = CURVE_BEAT, CURVE_T0
    bar = 4 * b
    chords = ["Dm", "Bb", "Gm", "A", "Dm", "Bb"]
    for i, ch in enumerate(chords):
        tb = t0 + i * bar
        r = ROOT[ch] if ROOT[ch] >= 38 else ROOT[ch] + 12
        if i == 5:  # Bb -> A in the last bar
            bass_run(tb, b / 2, [r, r + 12, r, r + 12, 45, 57, 45, 57], vel=0.46)
        else:
            bass_run(tb, b / 2, [r, r + 12] * 4, vel=0.44)
        if i == 5:
            arp(tb, tb + 2 * b, "Bb", b / 4, vel=0.11 + 0.01 * i)
            arp(tb + 2 * b, tb + bar, "A", b / 4, vel=0.13)
        else:
            arp(tb, tb + bar, ch, b / 4, vel=0.09 + 0.01 * i, pattern=(0, 1, 2, 3, 2, 1))
        for k in range(4):  # drums
            kick(tb + k * b, 0.42)
            hat(tb + k * b + b / 2, 0.10 + 0.01 * i)
            if i >= 4:
                hat(tb + k * b + b / 4, 0.06)
                hat(tb + k * b + 3 * b / 4, 0.06)
            if i >= 2 and k % 2 == 1:
                snare(tb + k * b, 0.22)
        if i >= 1:  # harmony: offbeat stabs
            stab = CH["A"] if i == 5 else CH[ch]
            for k in range(4):
                for m in (CH["Bb"] if (i == 5 and k < 2) else stab):
                    note("harm", tb + k * b + b / 2, 0.12, m, 0.055 + 0.006 * i, 0.125, -0.45,
                         a=0.003, dcy=0.04, s=0.5, r=0.02, vib=False)
    # tension climb into the stamp: snare roll over the last two beats
    for k, t in enumerate(times(t0 + 5 * bar + 2 * b, b / 4, 8)):
        snare(float(t), 0.10 + 0.025 * k)
    lead = [  # enters in bar 3, minor-key urgency
        (8, 1.5, 74), (9.5, .5, 77), (10, 1, 79), (11, .5, 77), (11.5, .5, 74),
        (12, 1.5, 76), (13.5, .5, 73), (14, 1, 76), (15, 1, 81),
        (16, .5, 81), (16.5, .5, 80), (17, 1, 81), (18, .5, 84), (18.5, .5, 82), (19, 1, 81),
        (20, .5, 82), (20.5, .5, 81), (21, .5, 79), (21.5, .5, 77),
        (22, .5, 76), (22.5, .5, 77), (23, .5, 79), (23.5, .5, 80)]
    seq("lead", t0, b, lead, vel=0.26, duty=0.25, pan=0.0)

    # 13.4 stamp: hard D-minor hit, then a plain descending figure to the cut
    for m in [62, 65, 69]:
        note("harm", 13.4, 0.3, m, 0.10, 0.25, -0.45, vib=False)
    note("lead", 13.4, 0.3, 81, 0.30, 0.5, vib=False)
    note("bass", 13.4, 1.45, D2, 0.50, wave_="tri", a=0.003, dcy=0.6, s=0.3, r=0.2, vib=False)
    crash(13.4, 0.18, 0.4)
    for k, (t, m) in enumerate([(13.8, 81), (14.1, 77), (14.4, 74), (14.7, 73)]):
        note("lead", t, 0.26, m, 0.16 - 0.025 * k, 0.125, vib=False)


SEAL_BEAT = 0.4  # 150 BPM; bars at 14.8, 16.4, 18.0, 19.6 -> 21.2 lights_out


def score_sealed():
    """15.2-21.2  music thins to a bass pulse; hard stop (gated) at lights_out."""
    b = SEAL_BEAT
    # bass: 8ths -> quarters, slowly losing energy
    bass_run(15.2, b / 2, [D2, D2 + 12] * 3, vel=0.36)                 # 15.2-16.4 Dm
    bass_run(16.4, b / 2, [34 + 12, 34 + 24] * 4, vel=0.33)            # Bb
    bass_run(18.0, b, [43, 43, 43, 43], vel=0.30)                      # Gm
    bass_run(19.6, b, [45, 45, 45, 45], vel=0.27, frac=0.7)            # A
    for k in range(3):
        for m in CH["Dm"]:
            note("harm", 15.2 + k * b, 0.22, m, 0.05, 0.125, -0.45, vib=False)
    for k in (0, 2):
        for m in CH["Bb"]:
            note("harm", 16.4 + k * b, 0.3, m, 0.04, 0.125, -0.45, vib=False)
    for t, d, m in [(15.6, .35, 69), (16.0, .7, 74), (17.2, .35, 72), (17.6, .7, 69)]:
        note("lead", t, d, m, 0.14, 0.25)
    for t in times(15.4, b, 7):
        hat(float(t), 0.05)


STEP_T = times(28.0, 0.25, 13)                       # 28.0 .. 31.0
STEP_M = [65, 67, 69, 70, 72, 74, 76, 79, 81, 83, 85, 86, 88]  # rising, chord-fitted
REV_BEAT = 0.4  # bars at 31.4 (line_sweep), 33.0 (land), 34.6 (stamp_draw), 36.2, 37.8


def score_reveal():
    """27.4-37.8  rising build -> dominant hold -> D major on DRAW -> happy loop."""
    # 27.4 vault_open pickup: six rising notes on Bb
    for k, m in enumerate([58, 62, 65, 70, 74, 77]):
        note("arp", 27.4 + 0.1 * k, 0.08, m, 0.08 + 0.015 * k, 0.25, 0.45, vib=False, r=0.01)
    groups = [("Bb", 28.0, 29.0, 46), ("C", 29.0, 30.0, 48), ("Asus", 30.0, 31.0, 45)]
    for gi, (ch, ta, tb, r) in enumerate(groups):
        arp(ta, tb, ch, 0.125, oct_=12 + 12 * (gi > 0), vel=0.10 + 0.025 * gi)
        bass_run(ta, 0.25, [r, r + 12, r, r + 12], vel=0.38 + 0.03 * gi)
        for m in CH[ch]:
            note("harm", ta, tb - ta - 0.02, m, 0.05 + 0.015 * gi, 0.125 * (gi + 1), -0.45, s=0.7, vib=False)
        for t in times(ta, 0.5, 2):
            kick(float(t), 0.35 + 0.05 * gi)
        for t in times(ta + 0.25, 0.5, 2):
            hat(float(t), 0.08)
    for k, t in enumerate(times(30.0, 0.125, 8)):     # roll into the arrival
        snare(float(t), 0.08 + 0.025 * k)

    # 31.0 arrival on A, 31.4-32.6 shimmer over an A pedal
    for m in CH["A"]:
        note("harm", 31.0, 1.55, m, 0.07, 0.25, -0.45, a=0.01, dcy=0.3, s=0.5, r=0.1, vib=False)
    kick(31.0, 0.45)
    crash(31.0, 0.10, 0.3)
    bass_run(31.0, 0.2, [45, None, 45, None, 45, None, 45, None, 45, None], vel=0.30)
    arp(31.4, 32.6, "A", 0.05, oct_=24, vel=0.055, duty=0.125, pan=0.5, pattern=(0, 1, 2, 3, 2, 1))
    # 33.0 land: unified -- every voice on the same pitch class (A)
    note("lead", 33.0, 0.5, 81, 0.26, 0.5, vib=False, r=0.15)
    note("harm", 33.0, 0.5, 69, 0.10, 0.25, -0.45, vib=False, r=0.15)
    note("arp", 33.0, 0.5, 93, 0.06, 0.25, 0.45, vib=False, r=0.15)
    bass_run(33.0, REV_BEAT, [45, 45, 45, 45], vel=0.36)
    for t in times(33.0, REV_BEAT, 4):
        hat(float(t) + 0.2, 0.07)
    for k, t in enumerate(times(33.8, 0.1, 8)):       # roll into DRAW
        snare(float(t), 0.07 + 0.03 * k)

    # 34.6 DRAW: bright resolved D major, everything at once
    note("lead", 34.6, 0.62, 86, 0.34, 0.5, r=0.08)
    for m in [66, 69, 74, 78]:
        note("harm", 34.6, 0.62, m, 0.09, 0.25, -0.45, vib=False, r=0.08)
    note("bass", 34.6, 0.62, D2, 0.45, wave_="tri", vib=False, s=0.8, r=0.06)
    note("bass", 34.6, 0.62, D3, 0.25, wave_="tri", vib=False, s=0.8, r=0.06)
    arp(34.6, 35.0, "D", 0.05, oct_=24, vel=0.08)
    kick(34.6, 0.45)
    crash(34.6, 0.26, 0.5, 1.4)

    # happy loop: 35.0-37.8 (rest of bar 34.6 + bar 36.2)
    b = REV_BEAT
    lead = [(1, .5, 81), (1.5, .5, 83), (2, .5, 86), (2.5, .5, 85), (3, 1, 86),
            (4, .5, 83), (4.5, .5, 86), (5, 1, 91), (6, .5, 88), (6.5, .5, 86), (7, 1, 85)]
    seq("lead", 34.6, b, lead, vel=0.24, duty=0.25)
    chords = ["D", "D", "D", "D", "G", "G", "A", "A"]
    for k, ch in enumerate(chords):
        tk = 34.6 + k * b
        if k >= 1:
            for m in CH[ch]:
                note("harm", tk + b / 2, 0.12, m, 0.06, 0.125, -0.45, vib=False)
        r = ROOT[ch]
        bass_run(tk, b / 2, [r, r + 12], vel=0.40) if k >= 1 else None
        if k >= 1:
            (kick if k % 2 == 0 else snare)(tk, 0.40 if k % 2 == 0 else 0.20)
            hat(tk + b / 2, 0.08)


NUM_T0, NUM_BEAT = 37.8, 0.4  # bars 37.8, 39.4, then a beat + pickup to 41.7


def score_numbers():
    """37.8-41.7  confident groove in D; lead kept light so the bar pops read."""
    b, t0 = NUM_BEAT, NUM_T0
    prog = [("D", 0), ("D", 2), ("G", 4), ("A", 6), ("A", 8)]
    for ch, beat in prog:
        tb = t0 + beat * b
        r = ROOT[ch]
        nbeats = 2 if beat < 8 else 1
        pat = [r, r + 12, None, r + 7][: nbeats * 2]
        bass_run(tb, b / 2, pat, vel=0.42)
        for k in range(nbeats):
            for m in CH[ch]:
                note("harm", tb + k * b + b / 2, 0.11, m, 0.06, 0.25, -0.45, vib=False)
    for k in range(9):
        tk = t0 + k * b
        (kick if k % 2 == 0 else snare)(tk, 0.42 if k % 2 == 0 else 0.20)
        if k % 2 == 0:
            kick(tk + 0.3 * b * 2.5, 0.25) if k < 8 else None
        hat(tk + b / 2, 0.08)
    lead = [(0, .5, 78), (.5, .5, 81), (1.5, .5, 83), (2, 1, 81), (3, .5, 78), (3.5, .5, 76),
            (4, .5, 79), (4.5, .5, 83), (5.5, .5, 86), (6, 1, 85), (7, 1, 88)]
    seq("lead", t0, b, lead, vel=0.20, duty=0.5)
    for t, m in zip(times(41.4, 0.1, 3), [81, 83, 85]):   # pickup into the logo
        note("lead", float(t), 0.085, m, 0.22, 0.25, vib=False, r=0.01)
        snare(float(t), 0.10)


def score_end():
    """41.7-45.0  victory jingle, last note D6 at 43.0 ringing out by 44.9."""
    note("lead", 41.7, 0.26, 86, 0.30, 0.5, vib=False)
    for m in [66, 69, 74]:
        note("harm", 41.7, 0.26, m, 0.09, 0.25, -0.45, vib=False)
    note("bass", 41.7, 0.26, D2, 0.5, wave_="tri", vib=False)
    kick(41.7, 0.55)
    crash(41.7, 0.15, 0.25, 0.8)
    jingle = [(42.0, .11, 83), (42.12, .11, 85), (42.24, .11, 86), (42.36, .22, 88),
              (42.6, .13, 81), (42.75, .2, 85)]
    for t, d, m in jingle:
        note("lead", t, d, m, 0.26, 0.25, vib=False, r=0.012)
    for t, ch in [(42.0, "G"), (42.36, "A")]:
        for m in CH[ch]:
            note("harm", t, 0.3, m, 0.07, 0.25, -0.45, vib=False)
    bass_run(42.0, 0.12, [43, 55, 43, 45, 57, 45, None, 45], vel=0.4)
    for t in times(42.0, 0.24, 4):
        hat(float(t), 0.07)
    # the final note: one clean D6, square + vibrato, power-curve ring to 44.9
    t0, t1 = 43.0, 44.9
    n = nsamp(t1 - t0)
    x = np.arange(n) / n
    env = (1.0 - x) ** 2.6
    env[: int(0.004 * SR)] *= np.linspace(0, 1, int(0.004 * SR))
    f = vib_freq(float(mtof(86)), n, depth_cents=10.0, rate=5.2, delay=0.25)
    add("lead", t0, pulse(f, 0.5) * env, 0.0, 0.30)
    note("bass", t0, 0.5, D2, 0.45, wave_="tri", vib=False, a=0.003, dcy=0.3, s=0.2, r=0.15)
    kick(t0, 0.4)


def compose():
    score_attract()
    score_curve()
    score_sealed()
    score_reveal()
    score_numbers()
    score_end()


# --------------------------------------------------------------------- SFX
# Every SFX goes on the "sfx" bus at its exact timeline time (no offsets).

def blip(t, m, d=0.05, vel=0.1, duty=0.5, pan=0.0, slide=0.0, tau=None, wave_="pulse"):
    n = nsamp(d)
    f = np.full(n, float(mtof(m)))
    if slide:
        f = f * 2.0 ** (np.linspace(0.0, slide, n) / 12.0)
    y = pulse(f, duty) if wave_ == "pulse" else (triangle(f, 0) if wave_ == "tri" else sine(f))
    add("sfx", t, y * perc(n, 0.002, tau or d * 0.45), pan, vel)


def bell(t, m, d=0.6, vel=0.12, pan=0.0, tau=0.22):
    """Bright chime: sine + 2.76x inharmonic partial + a hint of square bite."""
    n = nsamp(d)
    f = float(mtof(m))
    tt = np.arange(n) / SR
    y = (np.sin(2 * np.pi * f * tt) + 0.35 * np.sin(2 * np.pi * f * 2.76 * tt) * np.exp(-tt / 0.08)
         + 0.25 * pulse(np.full(n, f), 0.5) * np.exp(-tt / 0.04))
    add("sfx", t, y * perc(n, 0.001, tau), pan, vel)


def sfx_coin(t, lo=95, hi=100, vel=0.085):
    """Two-tone ding (coin)."""
    bell(t, lo, 0.09, vel, tau=0.05)
    bell(t + 0.07, hi, 0.55, vel, tau=0.18)


def sfx_sweep(t0, t1, vel=0.05):
    """Stepped rising sweep, corridor by corridor."""
    steps = 22
    dt = (t1 - t0) / steps
    for k in range(steps):
        m = 55 + k * 1.6
        blip(t0 + k * dt, m, dt * 0.9, vel * (0.6 + 0.4 * k / steps), 0.125, pan=-0.5 + k / steps, tau=dt * 0.6)


def sfx_stamp(t, vel=0.5, bright=False):
    """Thud: low noise burst + low square with a small pitch drop + sub."""
    n = nsamp(0.45)
    tt = np.arange(n) / SR
    f = 62.0 * 2.0 ** (-3.0 * np.minimum(tt / 0.12, 1.0) / 12.0)
    body = pulse(f, 0.5) * np.exp(-tt / 0.09) * 0.7
    sub = triangle(f * 0.5, 0) * np.exp(-tt / 0.14) * 0.8
    burst = noise(n, "lo") * np.exp(-tt / 0.035) * 0.9
    y = (body + sub + burst) * perc(n, 0.001, 10.0)
    add("sfx", t, y, 0.0, vel)
    if bright:
        n2 = nsamp(0.08)
        add("sfx", t, noise(n2, "hi") * perc(n2, 0.001, 0.02), 0.0, vel * 0.3)


def sfx_click(t, vel=0.16, hi=False):
    """Capsule lock click / countdown tick: noise snap + short tone."""
    n = nsamp(0.03)
    add("sfx", t, noise(n, "hi") * perc(n, 0.0005, 0.004), 0.1, vel * 0.8)
    blip(t, 103 if hi else 96, 0.04 if not hi else 0.09, vel * (0.8 if hi else 0.45), 0.25, tau=0.012 if not hi else 0.035)


def sfx_powerdown(t, vel=0.09):
    n = nsamp(0.7)
    tt = np.arange(n) / SR
    f = 40.0 + 560.0 * np.exp(-tt / 0.16)
    y = pulse(f, 0.25) * np.exp(-tt / 0.22) + noise(n, "lo") * np.exp(-tt / 0.05) * 0.4
    add("sfx", t, y * perc(n, 0.002, 10.0), 0.0, vel)


def sfx_whoosh(t, d=0.9, vel=0.07):
    """Noise through a one-pole low-pass whose cutoff rises (vault opens)."""
    n = nsamp(d)
    w = noise(n)
    tt = np.arange(n) / n
    fc = 300.0 * (8000.0 / 300.0) ** tt
    a = 1.0 - np.exp(-2 * np.pi * fc / SR)
    y = np.empty(n)
    acc = 0.0
    for i in range(n):
        acc += a[i] * (w[i] - acc)
        y[i] = acc
    env = np.sin(np.pi * np.clip(tt * 1.05, 0, 1)) ** 1.5
    add("sfx", t, y * env * 2.0, 0.0, vel)


def sfx_shimmer(t0, t1, vel=0.03):
    """Line sweep: high A-major pings travelling left -> right with the line."""
    pool = [93, 97, 100, 105, 109, 112]
    k_n = 26
    for k in range(k_n):
        t = t0 + (t1 - t0) * (k + RNG.uniform(0, 0.8)) / k_n
        bell(float(t), pool[k % len(pool)], 0.25, vel, pan=-0.7 + 1.4 * k / k_n, tau=0.07)


def place_sfx(tl):
    ev = {}
    for e in tl["events"]:
        ev.setdefault(e["type"], []).append(e["t"])
    T = lambda k, i=0: ev[k][i]

    blip(T("blink"), 88, 0.04, 0.04, 0.25)
    sfx_coin(T("coin_clink"))
    sfx_sweep(T("sweep_start"), 3.6)
    for k, m in enumerate([98, 102, 105]):                     # title sparkle
        bell(T("title") + 0.05 * k, m, 0.3, 0.025, pan=0.3, tau=0.08)

    for k, m in enumerate([74, 77, 81, 86]):                   # 1P START, D minor
        blip(T("start_jingle") + 0.07 * k, m + 12, 0.07 if k < 3 else 0.22, 0.10, 0.25, tau=0.04 if k < 3 else 0.1)
    blip(T("bot_go"), 84, 0.12, 0.08, 0.125, slide=12, tau=0.06)

    bot = times(T("bot_go"), 0.12, int(round((8.6 - T("bot_go")) / 0.12)) + 1)
    assert len(bot) == 31 and abs(bot[-1] - 8.6) < 1e-6
    for t in bot:  # one pitch, tiny random detune: soft, high, short
        blip(float(t), 93 + RNG.uniform(-0.1, 0.1), 0.035, 0.055, 0.5, pan=0.15, tau=0.012, wave_="tri")

    blip(T("crowd_go"), 72, 0.2, 0.07, 0.25, slide=7, tau=0.1)
    crowd = times(T("pellets_crowd"), 0.4, 5)
    assert abs(crowd[-1] - 10.6) < 1e-6
    for t in crowd:
        blip(float(t), 81, 0.06, 0.06, 0.5, pan=-0.2, tau=0.025, wave_="tri")

    grey = times(T("greyout"), 0.2, 8)
    assert abs(grey[-1] - 12.4) < 1e-6
    for k, t in enumerate(grey):  # descending, each with a small drop
        blip(float(t), [81, 79, 77, 76, 74, 72, 70, 69][k], 0.14, 0.09, 0.25, slide=-2, tau=0.06)
    for k in range(2):
        blip(T("hud") + 0.08 * k, 88, 0.04, 0.06, 0.125)
    sfx_stamp(T("stamp"), 0.15)

    blip(T("cut"), 79, 0.06, 0.06, 0.125, slide=5)              # 2P
    caps = times(T("capsules"), 0.4, 13)
    assert abs(caps[-1] - 20.8) < 1e-6
    for t in caps:
        sfx_click(float(t), 0.10)
        blip(float(t) + 0.012, 50, 0.05, 0.07, 0.5, tau=0.015, wave_="tri")  # low "clack"
    sfx_powerdown(T("lights_out"))
    ticks = times(T("ticks"), 0.4, 10)
    assert abs(ticks[-1] - 25.2) < 1e-6
    for k, t in enumerate(ticks):
        sfx_click(float(t), 0.10, hi=(k == len(ticks) - 1))
    blip(T("sealed"), 74, 0.09, 0.06, 0.5, tau=0.05)          # BIDS SEALED confirm
    blip(T("sealed") + 0.1, 81, 0.25, 0.06, 0.5, tau=0.1)
    sfx_stamp(T("sealed"), 0.06)

    for k, t in enumerate(times(T("continue"), 0.4, 3)):      # CONTINUE? flashes
        blip(float(t), 88, 0.06, 0.06, 0.25, tau=0.03)
    sfx_whoosh(T("vault_open"))

    assert len(STEP_T) == 13 and abs(STEP_T[0] - T("steps")) < 1e-6 and abs(STEP_T[-1] - 31.0) < 1e-6
    for k, (t, m) in enumerate(zip(STEP_T, STEP_M)):
        blip(float(t), m + 12, 0.12, 0.09 + 0.004 * k, 0.5, tau=0.05)
    sfx_shimmer(T("line_sweep"), 32.6)
    for m in (69, 81, 93):                                     # land: one pitch, every octave
        bell(T("land"), m, 0.9, 0.045, tau=0.3)
    sfx_coin(T("refund"), 88, 93, 0.07)
    sfx_stamp(T("stamp_draw"), 0.12, bright=True)

    for k, t in enumerate(ev["bar"]):                          # bar pops, rising
        blip(t, [86, 90, 93][k], 0.1, 0.10, 0.5, slide=5, tau=0.045)
        n = nsamp(0.02)
        add("sfx", t, noise(n, "hi") * perc(n, 0.0005, 0.004), 0.0, 0.10)
    sfx_stamp(T("logo"), 0.10)
    for k, m in enumerate([98, 102, 105, 110]):
        bell(T("logo") + 0.06 * k, m, 0.3, 0.04, pan=-0.3 + 0.2 * k, tau=0.08)
    for k, t in enumerate(times(T("press_start"), 0.5, 3)):
        blip(float(t), 93, 0.05, 0.03 - 0.007 * k, 0.25, tau=0.02)


# ------------------------------------------------------------------- mixer

def db(x):
    return 20.0 * np.log10(max(float(x), 1e-12))


def shift(x, k):
    y = np.zeros_like(x)
    y[k:] = x[: len(x) - k]
    return y


def echo(x, delay=0.3, fb=0.3, wet=0.22, taps=6):
    """Feedback delay unrolled as taps; alternate taps lean L/R for width."""
    d = int(delay * SR)
    out = x.copy()
    for k in range(1, taps + 1):
        g = wet * fb ** (k - 1)
        tap = shift(x, k * d) * g
        lean = 0.7 if k % 2 else 1.3
        out[:, 0] += tap[:, 0] * lean
        out[:, 1] += tap[:, 1] * (2.0 - lean)
    return out


def highpass(x, win=2048):
    """Remove sub-20 Hz drift: subtract a centred moving average (cumsum box)."""
    pad = np.pad(x, ((win, win), (0, 0)), mode="edge")
    c = np.cumsum(pad, axis=0)
    avg = (c[win:] - c[:-win]) / win
    avg = avg[win // 2: win // 2 + len(x)]
    return x - avg


def gate(t_off, t_on, ramp=0.015):
    """1 everywhere, 0 between t_off and t_on; ramps end exactly on the event."""
    t = np.arange(N) / SR
    g = np.ones(N)
    g = np.minimum(g, np.clip((t_off - t) / ramp, 0, 1) + (t >= t_on))
    up = (t > t_on - ramp) & (t < t_on)
    g[up] = (t[up] - (t_on - ramp)) / ramp
    return g


def rms_db(x, a, b_):
    seg = x[int(a * SR): int(b_ * SR)]
    return db(np.sqrt(np.mean(seg ** 2)) + 1e-12)


def mix():
    lead = echo(B["lead"])
    music = lead + B["harm"] + B["arp"] + B["bass"] + B["drums"]
    music = highpass(music, 16384)  # wide box: DC only, negligible pre-ring
    music *= gate(21.2, 27.4)[:, None]  # lights_out .. vault_open: music fully off
    act = np.concatenate([music[: int(21.2 * SR)], music[int(27.4 * SR): int(43.0 * SR)]])
    m_rms = np.sqrt(np.mean(act ** 2))
    music *= 10 ** (-18.0 / 20.0) / m_rms       # music at -18 dBFS RMS (active parts)
    sfx = B["sfx"] * 4.0          # SFX sit ~10 dB over the music
    total = music + sfx
    # gentle soft-knee limiter above 0.75, then peak-normalise to -1 dBFS
    a = np.abs(total)
    knee = 0.75
    over = a > knee
    total[over] = np.sign(total[over]) * (knee + (1 - knee) * np.tanh((a[over] - knee) / (1 - knee)))
    g = 10 ** (-1.0 / 20.0) / np.max(np.abs(total))
    total *= g
    fade = np.ones(N)
    nf = int(0.05 * SR)
    fade[:nf] = np.linspace(0, 1, nf)
    total *= fade[:, None]
    return total, music * g, sfx * g, g


def write_wav(path, x):
    x = np.clip(x, -1.0, 1.0)
    pcm = (x * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main():
    import sys
    if "--cut" in sys.argv:  # alternate masters live in their own modules
        cut = sys.argv[sys.argv.index("--cut") + 1]
        assert cut == "30", f"unknown cut {cut!r} (known: 30)"
        sys.path.insert(0, HERE)
        import score30  # re-imports this file as module `audio` with fresh buses
        score30.main()
        return
    with open(os.path.join(HERE, "timeline.json")) as f:
        tl = json.load(f)
    assert abs(tl["duration"] - DUR) < 1e-9
    compose()
    place_sfx(tl)
    total, music, sfx, g = mix()
    assert total.shape == (N, 2)
    # checks: silence between ticks after lights_out, clean ring-out at the end
    gap = rms_db(total, 21.95, 22.0)
    tail = db(np.max(np.abs(total[-int(0.02 * SR):])))
    print(f"music RMS (active) -18.0 dBFS | full-mix RMS {rms_db(total, 0, DUR):.1f} dBFS"
          f" | peak {db(np.max(np.abs(total))):.2f} dBFS | post gain {db(g):.1f} dB"
          f" | stem peaks (after -6 dB) music {db(0.5 * np.max(np.abs(music))):.1f} sfx {db(0.5 * np.max(np.abs(sfx))):.1f}")
    print(f"RMS 21.95-22.00 (between ticks) {gap:.1f} dBFS | last 20 ms peak {tail:.1f} dBFS")
    assert gap < -80 and tail < -60, (gap, tail)
    write_wav(os.path.join(HERE, "audio.wav"), total)
    os.makedirs(os.path.join(HERE, "stems"), exist_ok=True)
    # stems are pre-limiter, written 6 dB down so the DRAW hit never clips them
    write_wav(os.path.join(HERE, "stems", "music.wav"), music * 0.5)
    write_wav(os.path.join(HERE, "stems", "sfx.wav"), sfx * 0.5)
    print("wrote audio.wav and stems/{music,sfx}.wav")


if __name__ == "__main__":
    main()
