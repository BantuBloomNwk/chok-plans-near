// The agent, with a face. The same robots as Cleat's, because it's the same idea: an agent you don't
// have to trust, whose most expressive moment is being refused. It thinks while the enclave judges,
// nods when a release clears, flinches when the plan says Busted, and stamps when rules are revealed.
//
// Everything here loads after the page is up and only draws while it can be seen. No WebGL, no robot,
// no error: the page works the same without it. Reduced motion holds every robot still.

const REACTION = { greet: 1400, cleared: 900, trimmed: 1100, refused: 1600, sealed: 1400 };
const idle = (f) => (window.requestIdleCallback || ((g) => setTimeout(g, 600)))(f);
const slow = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
let libs = null;
const load = () => (libs ||= Promise.all([import('three'), import('./agentMesh.ts')]));

// one renderer, one scene and a camera framed on a single robot
async function stage(host, size, dist = 7.05) {
  const [THREE, mesh] = await load();
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(size, size, false);
  renderer.setClearAlpha(0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  Object.assign(renderer.domElement.style, { width: `${size}px`, height: `${size}px`, display: 'block' });
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  mesh.dressScene(scene);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.ShadowMaterial({ opacity: 0.34 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -1.58; floor.receiveShadow = true; scene.add(floor);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
  cam.position.set(0, 0.16, dist); cam.lookAt(0, -0.04, 0);
  const robot = (index) => ({ index, rig: mesh.buildAgent(index), palette: mesh.PALETTES[index], persona: mesh.personaOf(index) });
  // drawn only while on screen and the tab is visible
  let onScreen = true, raf = 0, draw = null;
  const go = () => { cancelAnimationFrame(raf); const f = () => { if (!onScreen || document.hidden) return; raf = requestAnimationFrame(f); draw?.(performance.now() / 1000); }; f(); };
  new IntersectionObserver(([e]) => { const was = onScreen; onScreen = e.isIntersecting; if (onScreen && !was) go(); }).observe(host);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && onScreen) go(); });
  return { THREE, mesh, renderer, scene, cam, robot, setDraw: (fn) => { draw = fn; go(); } };
}

// the console's agent: one robot that reacts to what the chain said, and a look you can change
export function mountMascot(host, { seed = 'chok-plans-agent', size = 92 } = {}) {
  const live = { mood: 'greet', moodAt: performance.now() / 1000, talking: false };
  let back = null, look = 0, swap = null;
  try { look = Number(localStorage.getItem('cpn.agentLook') || 0) || 0; } catch { /* no storage */ }
  const label = { thinking: 'The agent is waiting for the judge', cleared: 'Released', refused: 'Busted', sealed: 'Rules revealed and checked' };
  const api = {
    set(mood) {
      live.mood = mood; live.moodAt = performance.now() / 1000;
      clearTimeout(back);
      if (REACTION[mood]) back = setTimeout(() => { live.mood = 'idle'; live.moodAt = performance.now() / 1000; }, REACTION[mood]);
      host.dataset.mood = mood; host.setAttribute('aria-label', label[mood] || 'The agent');
    },
    talk(on) { live.talking = !!on; },
    next() { look += 1; try { localStorage.setItem('cpn.agentLook', String(look)); } catch { /* fine */ } swap?.(); api.set('greet'); },
  };
  host.setAttribute('role', 'img'); api.set('greet');
  idle(async () => {
    let s; try { s = await stage(host, size); } catch { return; }
    let r = s.robot(s.mesh.buildIndex(seed, look)); s.scene.add(r.rig.root);
    swap = () => { s.scene.remove(r.rig.root); r.rig.dispose(); r = s.robot(s.mesh.buildIndex(seed, look)); s.scene.add(r.rig.root); };
    const fx = { charge: 0, talk: 0 }; let yaw = 0.5;
    s.setDraw((now) => {
      const still = slow();
      if (!still) yaw += 0.004;
      fx.charge += ((live.mood === 'thinking' ? 1 : 0) - fx.charge) * 0.2; fx.talk += ((live.talking ? 1 : 0) - fx.talk) * 0.09;
      s.mesh.poseAgent(r.rig, live.mood, still ? 0 : now - live.moodAt, still ? 0 : now, r.palette, r.persona, still ? { charge: 0, talk: 0 } : fx);
      r.rig.root.rotation.y = Math.sin(yaw) * 0.5;
      s.renderer.render(s.scene, s.cam);
    });
  });
  return api;
}

// the hero: a cast of robots taking turns, each in its own feeling, with a plain line about what it means
export function mountCarousel(host, caption, cast, { size = 340, every = 3600 } = {}) {
  idle(async () => {
    let s; try { s = await stage(host, size, 8.3); } catch { host.hidden = true; caption.hidden = true; return; }
    const robots = cast.map((c) => ({ ...c, ...s.robot(s.mesh.buildIndex(c.seed, 0)) }));
    let i = 0, startedAt = performance.now() / 1000;
    s.scene.add(robots[0].rig.root);
    caption.textContent = robots[0].line;
    const canvas = s.renderer.domElement;
    canvas.style.transition = 'opacity .45s ease';
    const turn = () => {
      if (slow()) return;
      canvas.style.opacity = '0';
      setTimeout(() => {
        s.scene.remove(robots[i].rig.root); i = (i + 1) % robots.length; s.scene.add(robots[i].rig.root);
        startedAt = performance.now() / 1000; caption.textContent = robots[i].line; canvas.style.opacity = '1';
      }, 460);
    };
    setInterval(() => { if (!document.hidden) turn(); }, every);
    const fx = { charge: 0, talk: 0 };
    s.setDraw((now) => {
      const r = robots[i], still = slow(), t = now - startedAt;
      // a reaction plays, then the robot settles, until its turn ends
      const mood = REACTION[r.mood] && t > REACTION[r.mood] / 1000 + 0.6 ? 'idle' : r.mood;
      fx.charge = r.mood === 'thinking' ? 1 : 0; fx.talk = r.mood === 'greet' ? 1 : 0;
      s.mesh.poseAgent(r.rig, mood, still ? 0 : t, still ? 0 : now, r.palette, r.persona, still ? { charge: 0, talk: 0 } : fx);
      r.rig.root.rotation.y = 0.35 + Math.sin(now * 0.35) * 0.25;
      s.renderer.render(s.scene, s.cam);
    });
  });
}
