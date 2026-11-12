// The agent, with a face. The same robot as Cleat's, because it's the same idea: an agent you don't
// have to trust, whose most expressive moment is being refused. It thinks while the enclave judges,
// nods when a release clears, flinches when the plan says Busted, and stamps when rules are revealed.
//
// It loads after the page is up and only draws while it can be seen. No WebGL, no robot, no error:
// the console works the same without it. Reduced motion holds it still.

const REACTION = { greet: 1400, cleared: 900, trimmed: 1100, refused: 1600, sealed: 1400 };

export function mountMascot(host, { seed = 'chok-plans-agent', size = 120 } = {}) {
  const live = { mood: 'greet', moodAt: performance.now() / 1000, talking: false, charging: false };
  let back = null;
  const api = {
    set(mood) {
      live.mood = mood; live.moodAt = performance.now() / 1000;
      clearTimeout(back);
      if (REACTION[mood]) back = setTimeout(() => { live.mood = 'idle'; live.moodAt = performance.now() / 1000; }, REACTION[mood]);
      host.dataset.mood = mood;
      host.setAttribute('aria-label', { thinking: 'The agent is waiting for the judge', cleared: 'Released', refused: 'Busted', sealed: 'Rules revealed and checked', greet: 'The agent', idle: 'The agent' }[mood] || 'The agent');
    },
    talk(on) { live.talking = !!on; },
  };
  host.setAttribute('role', 'img'); api.set('greet');

  const start = async () => {
    let THREE, mesh;
    try { [THREE, mesh] = await Promise.all([import('three'), import('./agentMesh.ts')]); } catch { return; }
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true }); } catch { return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size, size, false);
    renderer.setClearAlpha(0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    Object.assign(renderer.domElement.style, { width: `${size}px`, height: `${size}px` });
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    mesh.dressScene(scene);
    const index = mesh.buildIndex(seed, 0);
    const rig = mesh.buildAgent(index), palette = mesh.PALETTES[index], persona = mesh.personaOf(index);
    scene.add(rig.root);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.ShadowMaterial({ opacity: 0.38 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -1.58; floor.receiveShadow = true; scene.add(floor);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
    cam.position.set(0, 0.16, 7.05); cam.lookAt(0, -0.04, 0);

    const slow = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const fx = { charge: 0, talk: 0 };
    let raf = 0, onScreen = true, yaw = 0.5;
    new IntersectionObserver(([e]) => { const was = onScreen; onScreen = e.isIntersecting; if (onScreen && !was) { cancelAnimationFrame(raf); frame(); } }).observe(host);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && onScreen) { cancelAnimationFrame(raf); frame(); } });
    const frame = () => {
      if (!onScreen || document.hidden) return;
      raf = requestAnimationFrame(frame);
      const now = performance.now() / 1000;
      if (!slow) yaw += 0.004;
      const want = { charge: live.mood === 'thinking' ? 1 : 0, talk: live.talking ? 1 : 0 };
      fx.charge += (want.charge - fx.charge) * (want.charge > fx.charge ? 0.35 : 0.12);
      fx.talk += (want.talk - fx.talk) * 0.09;
      mesh.poseAgent(rig, live.mood, slow ? 0 : now - live.moodAt, slow ? 0 : now, palette, persona, slow ? { charge: 0, talk: 0 } : fx);
      rig.root.rotation.y = Math.sin(yaw) * 0.5;
      renderer.render(scene, cam);
    };
    frame();
  };
  // after the page has settled, so the robot never holds up the first paint
  (window.requestIdleCallback || ((f) => setTimeout(f, 600)))(() => start());
  return api;
}
