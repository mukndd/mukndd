<div align="center">

<img width="100%" alt="Mukund G" src="https://capsule-render.vercel.app/api?type=waving&height=200&color=0:4C1D95,50:7C3AED,100:A78BFA&text=Mukund%20G&fontColor=ffffff&fontSize=48&animation=fadeIn&fontAlignY=38&desc=building+whatever+catches+my+fancy%2C+then+seeing+what+happens&descAlignY=58&descSize=17&section=header" />

### Co-founder & Product Lead @ [Originull](https://originull.com) · AI/Automation Engineer · Bengaluru, India

[![Typing SVG](https://readme-typing-svg.demolab.com/?font=Fira+Code&size=20&pause=1200&color=A78BFA&center=true&vCenter=true&width=560&lines=Co-founder+%40+Originull%3A+AI-native+3D+tools;Training+game+AI+on+a+real+fly+connectome;Real+stars.+Real+deep+time.+Real+data.;An+automated+critic+before+anything+ships)](https://git.io/typing-svg)

[![Portfolio](https://img.shields.io/badge/portfolio-mukndd.com-A78BFA?style=for-the-badge)](https://mukndd.com)
[![Email](https://img.shields.io/badge/email-mukundg1101%40gmail.com-D14836?style=for-the-badge&logo=gmail&logoColor=white)](mailto:mukundg1101@gmail.com)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-mukndd1101-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://linkedin.com/in/mukndd1101)
![Profile views](https://komarev.com/ghpvc/?username=mukndd&color=a78bfa&style=for-the-badge&label=PROFILE+VIEWS)

</div>

---

## about me

I build across software, AI, hardware, and interactive systems: whatever a given idea actually needs. Most projects here start the same way: a question I couldn't leave alone that turned into something real enough to run, break, and keep pushing on.

- 🚀 Co-founder & Product Lead at **[Originull](https://originull.com)**: an AI platform that turns prompts/images into checkable, editable, versioned 3D, not an ungovernable mesh blob
- 🧠 Currently obsessed with whether a *real biological wiring diagram* (not a hand-designed network) can drive believable game AI. See **Flyweight** below
- 🎓 CS undergrad, Dayananda Sagar University (2026) · Network School, Singapore & Malaysia
- 🛠️ Comfortable across the whole stack: LLM orchestration and routing, backend/infra (Supabase, Postgres, FastAPI), and computer vision/hardware
- 📎 Every number on my [portfolio](https://mukndd.com) ships with a source and a verified flag: nothing renders without both. Same standard applies here.

```text
🔭 currently building   Originull's generation-routing and functional-critic pipeline
🧪 currently researching whether a fixed biological connectome can drive believable game AI (Flyweight)
🌱 currently learning    RAG architectures, embeddings and vector search, deeper LLM orchestration patterns
💬 ask me about          LLM routing/critics, connectome-constrained controllers, paleogeography in a guessing game
📫 reach me              mukundg1101@gmail.com
```

---

## what i'm building right now

**[Originull](https://originull.com)**: a browser workspace that turns product images, prompts, and existing 3D assets into customizable, web-ready 3D. The generation step is an LLM writing *parametric geometry code*, checked by an automated "Functional Critic" before it's ever shown as final, not a diffusion model guessing a mesh. Outbound LLM calls are standardized through a single gateway (OpenRouter) rather than direct provider clients, which keeps routing, cost review, and fallbacks easier to reason about. Full-stack ownership: product direction, the React/TypeScript/Three.js workspace, Supabase-backed auth/storage/billing, and the async generation pipeline (jobs, retries, webhooks, fallback handling). 717 of the production repo's 723 commits are mine.

<div align="center">
<sub>real generation results, not stock renders</sub>
<table>
<tr>
<td align="center" width="33%"><video src="https://github.com/mukndd/mukndd/raw/master/assets/originull/ring.mp4" width="100%" controls muted loop playsinline></video><br/><sub>ring</sub></td>
<td align="center" width="33%"><video src="https://github.com/mukndd/mukndd/raw/master/assets/originull/shoe.mp4" width="100%" controls muted loop playsinline></video><br/><sub>shoe</sub></td>
<td align="center" width="33%"><video src="https://github.com/mukndd/mukndd/raw/master/assets/originull/serum.mp4" width="100%" controls muted loop playsinline></video><br/><sub>serum bottle</sub></td>
</tr>
</table>
</div>

---

## selected projects

<table>
<tr>
<td width="50%" valign="top">

**🧬 [Flyweight](https://github.com/mukndd/flyweight)**
A 2D fighting game where one controller isn't hand-tuned: its wiring comes from the real **FlyWire fruit-fly connectome**, reduced to a fixed, hash-verified 1,536-neuron / 170,489-edge subgraph. Only the artificial sensory encoder and motor readout are trained (via Cross-Entropy Method); the biological graph never learns. First full training run: **0% → 100%** held-out win rate, reported alongside its own honestly-flagged caveats about brittle convergence.
`Python` `FastAPI` `WebSockets` `NumPy/SciPy` `React` `Three.js`

<img src="https://github.com/mukndd/mukndd/raw/master/assets/flyweight/v11-watch-wide.png" width="100%" alt="Flyweight watch mode: live fight and connectome activity panel" />
<img src="https://github.com/mukndd/mukndd/raw/master/assets/flyweight/v11-brain-close.png" width="100%" alt="close-up render of the trained 1,536-neuron subgraph" />

</td>
<td width="50%" valign="top">

**🌍 [Findin](https://findin.world)**
A browser game combining geography with deep time: read the evidence, guess **where** an animal lived and **when**, with real paleogeographic coastlines for extinct species instead of pretending ancient life belongs on today's map. Built the full content pipeline (GBIF, Paleobiology Database, GPlates-derived reconstructions) with quality gates; 60 species manually verified for launch.
`Next.js` `TypeScript` `Supabase` `PostHog`

<img src="https://github.com/mukndd/mukndd/raw/master/assets/findin/daily-gameplay.png" width="100%" alt="Findin Daily gameplay: evidence notes, a world map, and the geological time bar" />

</td>
</tr>
<tr>
<td width="50%" valign="top">

**✨ [Asterisms](https://asterisms.space)**
A daily constellation-learning game on a *real* astronomy catalogue: 88 IAU constellations, 74 Western asterisms, 9,036 real cataloged stars, projected with real gnomonic RA/Dec math, not decorative particle stars. Gameplay content is static/generated; Neon Postgres handles only puzzle scheduling and leaderboards, so a DB outage degrades the leaderboard, never the game. Sole builder: data pipeline, gameplay, frontend.
`Next.js` `Neon` `Drizzle` `PostHog` · [case study](https://github.com/mukndd/asterisms-case-study)
<br/><sub>live at asterisms.space, screenshot pending</sub>

</td>
<td width="50%" valign="top">

**🎓 [CareerBridge](https://github.com/mukndd/CareerBridge)**
A full-stack campus placement platform built for Dayananda Sagar University: student, recruiter, and admin flows with an OpenAI-assisted matching layer.
`NestJS` `PostgreSQL` `Prisma` `Redis` `OpenAI API` `React`
[live demo →](https://career-bridge-seven.vercel.app)

</td>
</tr>
<tr>
<td width="50%" valign="top">

**✋ [Gesture-Based System Equalizer](https://github.com/mukndd/gesture-based-eq)**
A webcam, your hand, and a 10-band system-wide audio EQ: no mouse, no sliders. Finger-count selects the band, a pinch adjusts it with exponential smoothing to kill jitter, an L-shape gesture locks it, a two-hand gesture resets. Drives real system audio through Equalizer APO.
`Python` `OpenCV` `MediaPipe` `PyQt5`
<br/><sub>real screenshot and benchmark numbers pending, source is public above</sub>

</td>
<td width="50%" valign="top">

**🐛 more in progress**
A hardware-verified back catalogue (Raspberry Pi + ESP32 ADB remote, OpenCV face-tracking LED-matrix eye) and a real-time polyphonic keyboard-instrument engine (`qwerty-instrument`) live on my [portfolio](https://mukndd.com), where every claim is checked against source, not just described.

</td>
</tr>
</table>

---

## skills & tools

**Languages**

![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![C](https://img.shields.io/badge/C-A8B9CC?style=for-the-badge&logo=c&logoColor=white)

**AI / backend**

![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![NestJS](https://img.shields.io/badge/NestJS-E0234E?style=for-the-badge&logo=nestjs&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)
![OpenAI](https://img.shields.io/badge/OpenAI-412991?style=for-the-badge&logo=openai&logoColor=white)
![NumPy](https://img.shields.io/badge/NumPy-013243?style=for-the-badge&logo=numpy&logoColor=white)

**Frontend / 3D**

![React](https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Next.js](https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=next.js&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-000000?style=for-the-badge&logo=three.js&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)

**Data / infra**

![Supabase](https://img.shields.io/badge/Supabase-3FCF8E?style=for-the-badge&logo=supabase&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)
![PostHog](https://img.shields.io/badge/PostHog-000000?style=for-the-badge&logo=posthog&logoColor=white)

**Vision / hardware**

![OpenCV](https://img.shields.io/badge/OpenCV-5C3EE8?style=for-the-badge&logo=opencv&logoColor=white)
![Raspberry Pi](https://img.shields.io/badge/Raspberry_Pi-A22846?style=for-the-badge&logo=raspberrypi&logoColor=white)

---

## github stats

<div align="center">

<img alt="Mukund's GitHub streak" src="https://github-readme-streak-stats.herokuapp.com/?user=mukndd&theme=tokyonight&hide_border=true" />

### contribution snake

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mukndd/mukndd/output/github-contribution-grid-snake-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/mukndd/mukndd/output/github-contribution-grid-snake.svg" />
  <img alt="a snake eating my GitHub contribution graph" src="https://raw.githubusercontent.com/mukndd/mukndd/output/github-contribution-grid-snake.svg" />
</picture>

</div>

---

<div align="center">

<img alt="a random dev quote" src="https://quotes-github-readme.vercel.app/api?type=horizontal&theme=tokyonight" />

*building whatever catches my fancy, then seeing what happens.* · reach me at **mukundg1101@gmail.com**

</div>
