#!/usr/bin/env python3
"""v3 30 s master of the "Even" soundtrack.

Run via `python3 audio.py --cut 30` (or directly). Reuses the instruments, SFX
voices and mixer helpers from audio.py; only the arrangement, the SFX placement
and the mix bus differ. Reads timeline-30.json, writes audio-30.wav
(44.1 kHz, 16-bit stereo, exactly 30.0 s). Deterministic (seeded noise).

Arc: cold open mid-race in D minor at ~171 BPM (stamp on the bar-6 downbeat,
7.0) -> hard stop 8.0 -> coin clink, silence -> light D pulse 9.4 -> drop out
at lights_out 12.2, four ticks -> rising build on the 13 steps -> A pedal ->
D major on DRAW 18.8 -> 109 BPM groove (downbeats 18.8, 21.0, 23.2, 25.4) ->
logo, victory jingle, one D6 ringing out to 29.9.
"""
import json
import os

import numpy as np

import audio as A

DUR = 30.0
A.DUR = DUR
A.N = int(round(DUR * A.SR))          # 1,323,000 frames
A.B = A.new_buses()
A.RNG = np.random.default_rng(30)
N, SR = A.N, A.SR
HERE = A.HERE

note, seq, arp, bass_run = A.note, A.seq, A.arp, A.bass_run
kick, snare, hat, crash = A.kick, A.snare, A.hat, A.crash
blip, bell, add, nsamp, times = A.blip, A.bell, A.add, A.nsamp, A.times
CH, ROOT, D2, D3 = A.CH, A.ROOT, A.D2, A.D3

HOOK_BEAT = 0.35          # ~171 BPM; bars 0.0 1.4 2.8 4.2 5.6 | 7.0 stamp
GROOVE_BEAT = 0.55        # ~109 BPM; bars 18.8 21.0 23.2 25.4
STEP_T = times(15.0, 0.15, 13)                                  # 15.0 .. 16.8
STEP_M = [65, 67, 69, 70, 72, 74, 76, 77, 79, 81, 83, 85, 88]   # Bb | C | A, rising
FINAL_T = 27.05           # final D6 (25.4 + 3 beats), rings to 29.9
GATES = [(8.0, 9.4), (12.2, 14.6)]  # music fully off: hard stop, lights_out


# --------------------------------------------------------------------- SFX
# Every SFX on the "sfx" bus at its exact timeline time. Text-only events
# (caption, question, tagline, cta) and cold_open / cut_black carry no SFX of
# their own: the music starts on 0.0 and the gate is the 8.0 cut.

def chip_pop(t, m, vel=0.07):
    blip(t, m, 0.09, vel, 0.5, slide=5, tau=0.04)
    n = nsamp(0.02)
    add("sfx", t, A.noise(n, "hi") * A.perc(n, 0.0005, 0.004), 0.0, vel)


def place_sfx(tl):
    ev = {}
    for e in tl["events"]:
        ev.setdefault(e["type"], []).append(round(e["t"], 4))
    T = lambda k, i=0: ev[k][i]

    # hook: the bot eats on the clock, the crowd arrives late, coins grey out
    bot = times(T("pellet_bot"), 0.1, 30)
    assert len(bot) == 30 and bot[0] == 0.0 and abs(bot[-1] - 2.9) < 1e-6
    for t in bot:  # one pitch, tiny detune (never a two-pitch alternation)
        blip(float(t), 93 + A.RNG.uniform(-0.1, 0.1), 0.035, 0.06, 0.5, pan=0.15, tau=0.012, wave_="tri")
    blip(T("crowd_go"), 72, 0.2, 0.07, 0.25, slide=7, tau=0.1)
    crowd = times(T("pellets_crowd"), 0.4, 4)
    assert abs(crowd[-1] - 4.8) < 1e-6
    for t in crowd:
        blip(float(t), 81, 0.06, 0.07, 0.5, pan=-0.2, tau=0.025, wave_="tri")
    grey = times(T("greyout"), 0.2, 8)
    assert abs(grey[-1] - 6.4) < 1e-6
    for k, t in enumerate(grey):  # 8 discrete descending drops
        blip(float(t), [81, 79, 77, 76, 74, 72, 70, 69][k], 0.14, 0.09, 0.25, slide=-2, tau=0.06)
    for k in range(2):
        blip(T("hud") + 0.08 * k, 88, 0.04, 0.06, 0.125)
    A.sfx_stamp(T("stamp"), 0.14)

    # turn: one coin in the dark
    A.sfx_coin(T("coin_clink"))

    # sealed
    blip(T("cut"), 79, 0.06, 0.06, 0.125, slide=5)             # 2P
    caps = times(T("capsules"), 0.2, 13)
    assert abs(caps[-1] - 12.0) < 1e-6
    for t in caps:
        A.sfx_click(float(t), 0.10)
        blip(float(t) + 0.012, 50, 0.05, 0.07, 0.5, tau=0.015, wave_="tri")  # low clack
    A.sfx_powerdown(T("lights_out"))
    ticks = [T("ticks") + 0.6 * k for k in range(4)]
    assert [round(x, 4) for x in ticks] == [12.4, 13.0, 13.6, 14.2]
    for k, t in enumerate(ticks):
        A.sfx_click(t, 0.11, hi=(k == 3))

    # reveal
    blip(T("vault_open"), 88, 0.06, 0.06, 0.25, tau=0.03)      # CONTINUE? flash
    A.sfx_whoosh(T("vault_open"), 0.8, 0.08)
    assert len(STEP_T) == 13 and abs(STEP_T[0] - T("steps")) < 1e-6 and abs(STEP_T[-1] - 16.8) < 1e-6
    for k, (t, m) in enumerate(zip(STEP_T, STEP_M)):
        blip(float(t), m + 12, 0.11, 0.08 + 0.004 * k, 0.5, tau=0.045)
    A.sfx_shimmer(T("line_sweep"), 17.6, 0.03)
    for m in (69, 81, 93):                                     # land: one pitch, every octave
        bell(T("land"), m, 0.9, 0.05, tau=0.3)
    A.sfx_coin(T("refund"), 88, 93, 0.07)
    A.sfx_stamp(T("stamp_draw"), 0.16, bright=True)

    # proof
    A.sfx_sweep(T("proof_cut"), T("proof_cut") + 0.4, 0.035)  # pixel dissolve
    assert ev["chip"] == [22.0, 22.9, 23.8]
    for k, t in enumerate(ev["chip"]):
        chip_pop(t, [86, 90, 93][k])

    # end
    A.sfx_stamp(T("logo"), 0.10)
    for k, m in enumerate([98, 102, 105, 110]):
        bell(T("logo") + 0.06 * k, m, 0.3, 0.04, pan=-0.3 + 0.2 * k, tau=0.08)
    for k, t in enumerate(times(T("press_start"), 0.5, 3)):
        blip(float(t), 93, 0.05, 0.028 - 0.007 * k, 0.25, tau=0.02)


# ------------------------------------------------------------------- mixer
DRIVE = 1.15  # pre-limiter drive: lands ~-15.5 LUFS, music ~-18 dBFS RMS in the final


def win_rms_db(x, a, b_):
    return A.rms_db(x, a, b_)


def mix():
    music = A.echo(A.B["lead"]) + A.B["harm"] + A.B["arp"] + A.B["bass"] + A.B["drums"]
    music = A.highpass(music, 16384)
    for off, on in GATES:  # after echo + sum, so delay taps die with the cut
        music *= A.gate(off, on, ramp=0.006)[:, None]
    i = lambda t: int(round(t * SR))
    act = np.concatenate([music[: i(8.0)], music[i(9.4): i(12.2)], music[i(14.6): i(FINAL_T)]])
    music *= 10 ** (-18.0 / 20.0) / np.sqrt(np.mean(act ** 2))  # -18 dBFS RMS, active parts
    sfx = A.B["sfx"] * 4.0
    total = (music + sfx) * DRIVE
    a = np.abs(total)
    knee = 0.75
    over = a > knee
    total[over] = np.sign(total[over]) * (knee + (1 - knee) * np.tanh((a[over] - knee) / (1 - knee)))
    g = 10 ** (-1.0 / 20.0) / np.max(np.abs(total))
    total *= g
    nf = int(0.002 * SR)  # 2 ms click guard only: loud from frame 0
    total[:nf] *= np.linspace(0, 1, nf)[:, None]
    music_db = -18.0 + A.db(DRIVE * g)  # pre-limiter estimate of the music bus in the final
    return total, music_db, g


def checks(total):
    pk = np.max(np.abs(total), axis=1)
    rep = {
        "peak": A.db(pk.max()),
        "peak_t": pk.argmax() / SR,
        "rms_0.00-0.10": win_rms_db(total, 0.0, 0.1),
        "rms_8.00-8.14": win_rms_db(total, 8.006, 8.14),
        "rms_8.90-9.39": win_rms_db(total, 8.9, 9.39),
        "rms_13.35-13.55": win_rms_db(total, 13.35, 13.55),
        "rms_12.75-12.95": win_rms_db(total, 12.75, 12.95),
        "tail_20ms": A.db(pk[-int(0.02 * SR):].max()),
    }
    w = int(0.1 * SR)  # loudest 100 ms window (hop 10 ms)
    e = np.array([np.mean(total[k:k + w] ** 2) for k in range(0, N - w, int(0.01 * SR))])
    rep["loudest_100ms_t"] = e.argmax() * 0.01
    rep["rms_7.00-7.10"] = win_rms_db(total, 7.0, 7.1)
    rep["rms_18.80-18.90"] = win_rms_db(total, 18.8, 18.9)
    for k, v in rep.items():
        print(f"  {k:18s} {v:8.2f}")
    assert total.shape == (N, 2)
    assert rep["rms_0.00-0.10"] > -22, "cold open must be loud from frame 0"
    assert rep["rms_8.00-8.14"] < -80 and rep["rms_8.90-9.39"] < -80, "turn must be silent but the clink"
    assert rep["rms_13.35-13.55"] < -80, "silence between ticks"
    assert 18.79 <= rep["peak_t"] <= 19.0 and 18.7 <= rep["loudest_100ms_t"] <= 18.9, "DRAW must be the biggest hit"
    assert rep["tail_20ms"] < -60, "ring-out must end clean"


# ------------------------------------------------------------------- score

def score_hook():
    """0.0-8.0  cold open mid-race, D minor, ~171 BPM. Everything on 0.0; bar 6
    downbeat = stamp 7.0; keeps driving until the 8.0 gate cuts it dead."""
    b = HOOK_BEAT
    bar = 4 * b
    chords = ["Dm", "Bb", "Gm", "Dm", "Bb"]
    for i, ch in enumerate(chords):
        tb = i * bar
        r = ROOT[ch] if ROOT[ch] >= 38 else ROOT[ch] + 12
        if i == 2:    # Gm -> A
            bass_run(tb, b / 2, [43, 55, 43, 55, 45, 57, 45, 57], vel=0.46)
        elif i == 4:  # Bb -> A, the climb
            bass_run(tb, b / 2, [r, r + 12, r, r + 12, 45, 57, 45, 57], vel=0.48)
        else:
            bass_run(tb, b / 2, [r, r + 12] * 4, vel=0.46)
        halves = [("Gm", "A")] if i == 2 else ([("Bb", "A")] if i == 4 else [(ch, ch)])
        c1, c2 = halves[0]
        arp(tb, tb + 2 * b, c1, b / 4, vel=0.10 + 0.008 * i, pattern=(0, 1, 2, 3, 2, 1))
        arp(tb + 2 * b, tb + bar, c2, b / 4, vel=0.10 + 0.008 * i, pattern=(0, 1, 2, 3, 2, 1))
        for k in range(4):
            kick(tb + k * b, 0.46)
            hat(tb + k * b + b / 2, 0.10)
            if i >= 2:
                hat(tb + k * b + b / 4, 0.055)
                hat(tb + k * b + 3 * b / 4, 0.055)
            if k % 2 == 1 and not (i == 4 and k == 3):
                snare(tb + k * b, 0.24)
            for m in CH[c1 if k < 2 else c2]:  # offbeat stabs
                note("harm", tb + k * b + b / 2, 0.11, m, 0.06 + 0.005 * i, 0.125, -0.45,
                     a=0.003, dcy=0.04, s=0.5, r=0.02, vib=False)
    crash(0.0, 0.20, 0.35)  # hits on frame 0
    for k, t in enumerate(times(7.0 - 2 * b, b / 4, 8)):  # roll into the stamp
        snare(float(t), 0.10 + 0.03 * k)
    lead = [
        (0, .5, 74), (.5, .5, 77), (1, .5, 81), (1.5, .25, 79), (1.75, .25, 81),
        (2, .5, 82), (2.5, .5, 81), (3, .5, 77), (3.5, .5, 76),
        (4, .5, 74), (4.5, .5, 77), (5, .5, 82), (5.5, .25, 81), (5.75, .25, 82),
        (6, .5, 86), (6.5, .5, 84), (7, .5, 82), (7.5, .5, 81),
        (8, .5, 79), (8.5, .5, 82), (9, .5, 86), (9.5, .5, 84),
        (10, .5, 85), (10.5, .5, 81), (11, .5, 76), (11.5, .5, 79),
        (12, .5, 74), (12.5, .5, 77), (13, .5, 81), (13.5, .25, 79), (13.75, .25, 81),
        (14, .5, 86), (14.5, .5, 84), (15, .5, 82), (15.5, .5, 81),
        (16, .5, 82), (16.5, .5, 81), (17, .5, 82), (17.5, .5, 84),
        (18, .25, 85), (18.25, .25, 86), (18.5, .25, 87), (18.75, .25, 88)]
    seq("lead", 0.0, b, lead, vel=0.27, duty=0.25, pan=0.0)

    # 7.0 stamp: hard D-minor hit, then the race grinds on until the cut
    t = 7.0
    note("lead", t, 0.33, 86, 0.32, 0.5, vib=False)
    for m in [62, 65, 69, 74]:
        note("harm", t, 0.33, m, 0.10, 0.25, -0.45, vib=False)
    note("bass", t, 0.33, D2, 0.52, wave_="tri", vib=False)
    kick(t, 0.6)
    crash(t, 0.22, 0.4)
    bass_run(t + b, b / 2, [D3, D3 + 1, D3, D3 + 1, D3, D3 + 1], vel=0.46)  # D-Eb grind
    for k in range(1, 3):
        kick(t + k * b, 0.46)
        snare(t + k * b + b / 2, 0.18)
        for j in range(4):
            hat(t + k * b + j * b / 4, 0.07)
    seq("lead", t, b / 2, [(2, 1, 81), (3, 1, 80), (4, 1, 81), (5, 1, 80)], vel=0.24, duty=0.25)
    for k in range(2, 6):
        for m in ([62, 65, 69] if k % 2 == 0 else [63, 66, 69]):
            note("harm", t + k * b / 2, 0.12, m, 0.07, 0.125, -0.45, vib=False)


SEAL_BEAT = 0.4  # beats 9.4, 9.8, ...; the capsule clicks (9.6 + 0.2k) fall on the ands


def score_sealed():
    """9.4-12.2  light pulse: soft bass quarters, a held pad, a sparse lead.
    Gated to silence at lights_out 12.2."""
    b = SEAL_BEAT
    bass_run(9.4, b, [D2, D2, D2, D2], vel=0.34, frac=0.55)
    bass_run(11.0, b, [34 + 12, 34 + 12, 34 + 12], vel=0.32, frac=0.55)
    for m in CH["Dm"]:
        note("harm", 9.4, 1.55, m, 0.035, 0.125, -0.45, a=0.12, dcy=0.3, s=0.7, r=0.2, vib=False)
    for m in CH["Bb"]:
        note("harm", 11.0, 1.4, m, 0.035, 0.125, -0.45, a=0.12, dcy=0.3, s=0.7, r=0.2, vib=False)
    for t, d, m in [(9.8, .3, 69), (10.2, .7, 74), (11.4, .3, 72), (11.8, .5, 69)]:
        note("lead", t, d, m, 0.11, 0.25)
    for t in times(9.4, b, 7):
        kick(float(t), 0.16)


def score_reveal():
    """14.6-21.0  rising build on the 13 steps (Bb | C | A), A pedal under the
    sweep, unified A on land, D major on DRAW 18.8, then one bar of happy loop."""
    for k, m in enumerate([58, 62, 65, 70]):  # vault pickup
        note("arp", 14.6 + 0.1 * k, 0.08, m, 0.08 + 0.02 * k, 0.25, 0.45, vib=False, r=0.01)
    groups = [("Bb", 15.0, 46), ("C", 15.6, 48), ("Asus", 16.2, 45)]
    for gi, (ch, ta, r) in enumerate(groups):
        tb = ta + 0.6
        arp(ta, tb, ch, 0.075, oct_=12 + 12 * (gi > 0), vel=0.10 + 0.025 * gi)
        bass_run(ta, 0.15, [r, r + 12] * 2, vel=0.40 + 0.03 * gi)
        for m in CH[ch]:
            note("harm", ta, 0.58, m, 0.05 + 0.015 * gi, 0.125 * (gi + 1), -0.45, s=0.7, vib=False)
        for t in times(ta, 0.3, 2):
            kick(float(t), 0.36 + 0.06 * gi)
            hat(float(t) + 0.15, 0.08)
    for k, t in enumerate(times(16.2, 0.075, 8)):  # roll into the arrival
        snare(float(t), 0.08 + 0.025 * k)

    # 16.8 arrival on A; 17.0-17.6 shimmer over an A pedal
    for m in CH["A"]:
        note("harm", 16.8, 0.95, m, 0.07, 0.25, -0.45, a=0.01, dcy=0.3, s=0.5, r=0.1, vib=False)
    kick(16.8, 0.48)
    crash(16.8, 0.10, 0.3)
    bass_run(16.8, 0.2, [45, None, 45, None, 45], vel=0.32)
    arp(17.0, 17.6, "A", 0.05, oct_=24, vel=0.05, duty=0.125, pan=0.5, pattern=(0, 1, 2, 3, 2, 1))
    # 17.8 land: every voice on the same pitch class
    note("lead", 17.8, 0.45, 81, 0.26, 0.5, vib=False, r=0.15)
    note("harm", 17.8, 0.45, 69, 0.10, 0.25, -0.45, vib=False, r=0.15)
    note("arp", 17.8, 0.45, 93, 0.06, 0.25, 0.45, vib=False, r=0.15)
    bass_run(17.8, 0.25, [45, 45, 57, 45], vel=0.36)
    for t in (18.05, 18.55):
        hat(t, 0.07)
    for k, t in enumerate(times(18.45, 0.05, 7)):  # roll into DRAW
        snare(float(t), 0.07 + 0.035 * k)

    # 18.8 DRAW: the biggest, brightest moment -- D major, everything at once
    t = 18.8
    note("lead", t, 0.62, 86, 0.36, 0.5, r=0.08)
    note("lead", t, 0.62, 74, 0.14, 0.25, vib=False, r=0.08)
    for m in [66, 69, 74, 78]:
        note("harm", t, 0.62, m, 0.10, 0.25, -0.45, vib=False, r=0.08)
    note("bass", t, 0.62, D2, 0.50, wave_="tri", vib=False, s=0.8, r=0.06)
    note("bass", t, 0.62, D3, 0.28, wave_="tri", vib=False, s=0.8, r=0.06)
    arp(t, t + 0.4, "D", 0.05, oct_=24, vel=0.09)
    kick(t, 0.6)
    crash(t, 0.30, 0.5, 1.4)

    # happy loop 18.8-21.0 (one bar at the groove tempo)
    b = GROOVE_BEAT
    seq("lead", t, b, [(1, .5, 81), (1.5, .5, 83), (2, .5, 86), (2.5, .5, 85), (3, .5, 83), (3.5, .5, 85)],
        vel=0.24, duty=0.25)
    for k, ch in enumerate(["D", "D", "G", "A"]):
        tk = t + k * b
        r = ROOT[ch]
        if k >= 1:
            bass_run(tk, b / 2, [r, r + 12], vel=0.42)
            for m in CH[ch]:
                note("harm", tk + b / 2, 0.12, m, 0.065, 0.125, -0.45, vib=False)
            (kick if k % 2 == 0 else snare)(tk, 0.42 if k % 2 == 0 else 0.22)
        hat(tk + b / 2, 0.08)
        hat(tk + b / 4, 0.05)
        hat(tk + 3 * b / 4, 0.05)


def score_proof():
    """21.0-25.4  confident groove in D (bars 21.0, 23.2); lead kept light and
    out of the way of the chip pops at 22.0 / 22.9 / 23.8."""
    b, t0 = GROOVE_BEAT, 21.0
    prog = [("D", 0), ("Bm", 2), ("G", 4), ("A", 6)]
    for ch, beat in prog:
        tb = t0 + beat * b
        r = ROOT[ch] if ROOT[ch] < 47 else ROOT[ch] - 12
        bass_run(tb, b / 2, [r, r + 12, None, r + 7], vel=0.44)
        for k in range(2):
            for m in CH[ch]:
                note("harm", tb + k * b + b / 2, 0.12, m, 0.06, 0.25, -0.45, vib=False)
    for k in range(8):
        tk = t0 + k * b
        (kick if k % 2 == 0 else snare)(tk, 0.44 if k % 2 == 0 else 0.22)
        if k % 2 == 0:
            kick(tk + 0.75 * b, 0.26)
        hat(tk + b / 2, 0.08)
        hat(tk + b / 4, 0.045)
        hat(tk + 3 * b / 4, 0.045)
    lead = [(0, .5, 78), (.5, .5, 81), (1.5, .5, 83), (2, 1, 83), (3, .5, 81), (3.5, .5, 78),
            (4, .5, 79), (4.5, .5, 83), (5.5, .5, 86), (6, 1, 85), (7, .25, 81), (7.25, .25, 83), (7.5, .5, 85)]
    seq("lead", t0, b, lead, vel=0.19, duty=0.5)
    for t in times(25.4 - 3 * b / 4, b / 4, 3):  # snare pickup into the logo
        snare(float(t), 0.10)


def score_end():
    """25.4-30.0  logo hit, victory jingle, one D6 from 27.05 ringing out by 29.9."""
    t = 25.4
    note("lead", t, 0.3, 86, 0.32, 0.5, vib=False)
    for m in [66, 69, 74]:
        note("harm", t, 0.3, m, 0.09, 0.25, -0.45, vib=False)
    note("bass", t, 0.3, D2, 0.5, wave_="tri", vib=False)
    kick(t, 0.55)
    crash(t, 0.16, 0.25, 0.8)
    s16 = GROOVE_BEAT / 4
    t1 = t + GROOVE_BEAT  # 25.95
    jingle = [(0, 1, 83), (1, 1, 85), (2, 1, 86), (3, 2, 88), (5, 1, 85), (6, 1, 86), (7, 1, 88)]
    for off, ln, m in jingle:
        note("lead", t1 + off * s16, ln * s16 * 0.85, m, 0.26, 0.25, vib=False, r=0.012)
    for tt, ch in [(t1, "G"), (t1 + 4 * s16, "A")]:
        for m in CH[ch]:
            note("harm", tt, 0.4, m, 0.07, 0.25, -0.45, vib=False)
    bass_run(t1, s16, [43, 55, 43, 55, 45, 57, 45, 57], vel=0.4)
    for tt in times(t1, 2 * s16, 4):
        hat(float(tt), 0.07)
    # the final note: one clean D6, square + vibrato, power-curve ring to 29.9
    t0, t1 = FINAL_T, 29.9
    n = nsamp(t1 - t0)
    x = np.arange(n) / n
    env = (1.0 - x) ** 2.6
    env[: int(0.004 * SR)] *= np.linspace(0, 1, int(0.004 * SR))
    f = A.vib_freq(float(A.mtof(86)), n, depth_cents=10.0, rate=5.2, delay=0.25)
    add("lead", t0, A.pulse(f, 0.5) * env, 0.0, 0.30)
    for m in [66, 69]:
        note("harm", t0, 0.6, m, 0.05, 0.25, -0.45, vib=False, a=0.003, dcy=0.3, s=0.2, r=0.2)
    note("bass", t0, 0.6, D2, 0.45, wave_="tri", vib=False, a=0.003, dcy=0.3, s=0.2, r=0.15)
    kick(t0, 0.45)
    crash(t0, 0.08, 0.4, 1.0)


def compose():
    score_hook()
    score_sealed()
    score_reveal()
    score_proof()
    score_end()


def main():
    with open(os.path.join(HERE, "timeline-30.json")) as f:
        tl = json.load(f)
    assert abs(tl["duration"] - DUR) < 1e-9
    compose()
    place_sfx(tl)
    total, music_db, g = mix()
    print(f"score30: music RMS (active, in the final) {music_db:.1f} dBFS | post gain {A.db(g):.1f} dB"
          f" | full-mix RMS {win_rms_db(total, 0, DUR):.1f} dBFS")
    checks(total)
    out = os.path.join(HERE, "audio-30.wav")
    A.write_wav(out, total)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
