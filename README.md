<div align="center">

<img width="100%" alt="Mukund G" src="https://capsule-render.vercel.app/api?type=waving&height=200&color=0:4C1D95,50:7C3AED,100:A78BFA&text=Mukund%20G&fontColor=ffffff&fontSize=48&animation=fadeIn&fontAlignY=38&desc=building+whatever+catches+my+fancy&descAlignY=58&descSize=17&section=header" />

### Founding Engineer / Full-Stack Engineer · Bengaluru, India

[![Typing SVG](https://readme-typing-svg.demolab.com/?font=Fira+Code&size=20&pause=1200&color=A78BFA&center=true&vCenter=true&width=560&lines=Co-founder+of+Originull%3A+AI-native+3D+tools;Training+game+AI+on+a+real+fly+connectome;Real+stars.+Real+deep+time.+Real+data.;An+automated+critic+before+anything+ships)](https://git.io/typing-svg)

[![Portfolio](https://img.shields.io/badge/portfolio-mukndd.com-A78BFA?style=for-the-badge)](https://mukndd.com)
[![Email](https://img.shields.io/badge/email-mukundg1101%40gmail.com-D14836?style=for-the-badge&logo=gmail&logoColor=white)](mailto:mukundg1101@gmail.com)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-mukndd1101-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://linkedin.com/in/mukndd1101)

</div>

---

## about me

I build products end to end: from ambiguous requirements and UX through frontend, backend, AI workflows, auth/security, billing, observability, and production deployment. Most projects here start the same way: a question I couldn't leave alone that turned into something real enough to run, break, and keep pushing on.

- 🚀 Co-founder of **[Originull](https://originull.com)**: an AI platform that turns prompts/images into checkable, editable, versioned 3D. AI is one part of the work; the larger signal is full product ownership
- 🧠 Currently obsessed with whether a *real biological wiring diagram* (not a hand-designed network) can drive believable game AI. See **Flyweight** below
- 🎓 CS undergrad, Dayananda Sagar University (2026) · Network School, Singapore & Malaysia
- 📎 Every number on my [portfolio](https://mukndd.com) ships with a source and a verified flag: nothing renders without both. Same standard applies here

---

## what i'm building right now

**[Originull](https://originull.com)**: a browser workspace that turns product images, prompts, and existing 3D assets into customizable, web-ready 3D. The generation step is an LLM writing *parametric geometry code*, checked by an automated "Functional Critic" before it's ever shown as final, not a diffusion model guessing a mesh. Outbound LLM calls are standardized through a single gateway (OpenRouter) rather than direct provider clients, which keeps routing, cost review, and fallbacks easier to reason about. Full-stack ownership: product direction, the React/TypeScript/Three.js workspace, Supabase-backed auth/storage/billing, and the async generation pipeline (jobs, retries, webhooks, fallback handling). 717 of the production repo's 723 commits are mine.

<p align="center">
  <img src="media/originull-polar-bear-generated.png" width="49%" alt="Originull workspace showing a generated polar bear creative mesh" />
  <img src="media/originull-polar-bear-material.png" width="49%" alt="Originull workspace showing material editing on a polar bear mesh" />
</p>

---

## selected projects

<table>
<tr>
<td width="33%" valign="top">

**🧬 [Flyweight](https://github.com/mukndd/flyweight)**
A 2D fighting game where one controller isn't hand-tuned: its wiring comes from the real **FlyWire fruit-fly connectome**, reduced to a fixed, hash-verified 1,536-neuron / 170,489-edge subgraph. Only the artificial sensory encoder and motor readout are trained (via Cross-Entropy Method); the biological graph never learns. First full training run: **0% → 100%** held-out win rate, reported alongside its own honestly-flagged caveats about brittle convergence.
`Python` `FastAPI` `WebSockets` `NumPy/SciPy` `React` `Three.js`

<br/>
<img src="media/flyweight-game-controls.png" width="100%" alt="Flyweight arcade fight screen and controller UI" />
<img src="media/flyweight-connectome.png" width="100%" alt="FlyWire connectome visualization used as biological inspiration for Flyweight" />

</td>
<td width="33%" valign="top">

**🌍 [Findin](https://findin.world)**
A browser game combining geography with deep time: read the evidence, guess **where** an animal lived and **when**, with real paleogeographic coastlines for extinct species instead of pretending ancient life belongs on today's map. Built the full content pipeline (GBIF, Paleobiology Database, GPlates-derived reconstructions) with quality gates; 60 species manually verified for launch.
`Next.js` `TypeScript` `Supabase` `PostHog`

<br/>
<img src="media/findin-antique-world-map.png" width="100%" alt="Findin world-map visual for guessing where extinct species lived" />
<img src="media/findin-geologic-timescale.png" width="100%" alt="Findin deep-time visual showing geological periods" />

</td>
<td width="33%" valign="top">

**✨ [Asterisms](https://asterisms.space)**
A daily constellation-learning game on a *real* astronomy catalogue: 88 IAU constellations, 74 Western asterisms, 9,036 real cataloged stars, projected with real gnomonic RA/Dec math, not decorative particle stars. Neon Postgres handles only puzzle scheduling and leaderboards, so a DB outage degrades the leaderboard, never the game. Sole builder: data pipeline, gameplay, frontend.
`Next.js` `Neon` `Drizzle` `PostHog` · [case study](https://github.com/mukndd/asterisms-case-study)

<br/>
<img src="media/asterisms-constellation-map.png" width="100%" alt="Asterisms constellation map with real star positions" />
<img src="media/asterisms-star-atlas.png" width="100%" alt="Asterisms star-atlas visual with constellations and zodiac drawings" />

</td>
</tr>
</table>

## more builds

**✋ [Gesture-Based System Equalizer](https://github.com/mukndd/gesture-based-eq)**: a webcam, your hand, and a 10-band system-wide audio EQ: no mouse, no sliders. Finger-count selects the band, a pinch adjusts it with exponential smoothing to kill jitter, an L-shape gesture locks it, and a two-hand gesture resets.
`Python` `OpenCV` `MediaPipe` `PyQt5`

<p align="center">
  <img src="media/gesture-eq-live-bands.png" width="49%" alt="Gesture-Based System Equalizer live ten-band audio display" />
  <img src="media/gesture-eq-waveform.png" width="49%" alt="Gesture-Based System Equalizer waveform visual" />
</p>

More (CareerBridge, hardware builds) on the [portfolio](https://mukndd.com), where every claim is checked against source.

---

## core stack

![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Next.js](https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=next.js&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-000000?style=for-the-badge&logo=three.js&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3FCF8E?style=for-the-badge&logo=supabase&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![OpenCV](https://img.shields.io/badge/OpenCV-5C3EE8?style=for-the-badge&logo=opencv&logoColor=white)

Full breakdown per project on the [portfolio](https://mukndd.com).

---

<div align="center">

*building whatever catches my fancy.* · reach me at **mukundg1101@gmail.com**

</div>
