'use client';
// IPL auction room (three.js via React Three Fiber): a round table with one seated owner per franchise,
// each holding a numbered paddle, and an auctioneer with a gavel at the front.
// Everything is driven by the AUTHORITATIVE room state passed in from page.js (room.cur_bidder / cur_bid / last sale),
// so a paddle is up exactly while that team is the highest bidder, on every screen. Nothing here talks to the database.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Logo } from './components';
import { cr } from '../lib/supabase';

// ---------- maths ----------
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (x) => { const c = Math.min(Math.max(x, 0), 1); return c * c * (3 - 2 * c); };
const damp = (cur, target, k, dt) => cur + (target - cur) * (1 - Math.exp(-k * dt));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = THREE.MathUtils.clamp;

export const TABLE_Y = 0.78, SEAT_DROP = 0.35, TABLE_FWD = 0.95;   // table centre sits 0.95 in front of the seated person
export const AUC = { x: 0, z: -8.3 }, STAGE_Y = 0.35;           // auctioneer's position: elevated stage at the front of the hall
export const SHOULDER = { x: 0.3, y: 1.43, upper: 0.3, fore: 0.27 };
// arm poses: [shoulder x, shoulder z, elbow x]; r = 0 resting, 1 = fully raised
const REST = { paddle: [-0.45, 0.12, -1.42], gavel: [-0.35, 0.12, -1.3] }, UP = [0.2, 2.9, -0.25];
export const armPose = (r, item = 'paddle') => { const a = REST[item]; return { sx: lerp(a[0], UP[0], r), sz: lerp(a[1], UP[1], r), ex: lerp(a[2], UP[2], r) }; };
export const gavelAmount = (s) => { if (s < 0 || s >= 0.95) return 0; const ph = (s % 0.475) / 0.475; return ph < 0.55 ? smooth(ph / 0.55) : 1 - smooth((ph - 0.55) / 0.45); };
// Table positions in the hall (x = left/right, z = towards the stage (-) or the back of the room (+)). Filled in this order, so any
// number of teams (3-10) gets a mix of left, right, middle and rear tables, never a straight line.
const SLOTS = [[-5, -2.6], [5, -2.6], [0, 3.2], [-2.3, 0.2], [2.3, 0.2], [-5.8, 2.8], [5.8, 2.8], [-3.1, 5.4], [3.1, 5.4], [0, 7.4]];
export const slotsFor = (n, k = 1) => SLOTS.slice(0, n).map(([x0, z]) => {   // k < 1 squeezes the room sideways for tall/narrow (phone) screens
  const x = x0 * k;
  const yaw = Math.atan2(-x, AUC.z - (z + 0.2)) * 0.8;   // every rep faces (roughly) the auctioneer
  return { x, z, yaw, tx: x + Math.sin(yaw) * TABLE_FWD, tz: z + Math.cos(yaw) * TABLE_FWD };
});

const SKINS = ['#d6a07a', '#b9825c', '#8d5a3b', '#e8b895', '#a06b47'], HAIRS = ['#1a1412', '#2b1d14', '#111111', '#3a2a1c', '#4a3322'];
const abbr = (name = '') => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 4);
const pad = (n) => String(n).padStart(2, '0');

function useTex(draw, w, h, deps) {
  const tex = useMemo(() => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

const Mat = ({ c, r = 0.75, m = 0 }) => <meshStandardMaterial color={c} roughness={r} metalness={m} />;

// ---------- a person (seated owner or standing auctioneer) ----------
function Person({ pos, yaw, seated, item, skin, hair, suit, tie, index, target, no, short, color, strikeKey, lookAt }) {
  const root = useRef(), body = useRef(), head = useRef(), lidL = useRef(), lidR = useRef(), armR = useRef(), elbR = useRef(), handR = useRef(), held = useRef(), armL = useRef(), elbL = useRef();
  const live = useRef(); live.current = { target, strikeKey, lookAt };
  const st = useRef({ r: 0, seen: undefined, gStart: -100, look: 0, nextBlink: 1.5 + index * 0.8, blinkAt: -1 }).current;
  const tmp = useMemo(() => ({ a: new THREE.Quaternion(), b: new THREE.Quaternion(), c: new THREE.Quaternion(), e: new THREE.Euler() }), []);
  const suitC = useMemo(() => new THREE.Color(suit), [suit]);
  const padTex = useTex((g) => {
    g.fillStyle = '#fff'; g.beginPath(); g.arc(128, 128, 126, 0, Math.PI * 2); g.fill();
    g.lineWidth = 16; g.strokeStyle = color; g.beginPath(); g.arc(128, 128, 112, 0, Math.PI * 2); g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#111'; g.font = 'bold 118px Impact, "Arial Black", sans-serif'; g.fillText(pad(no || 0), 128, 108);
    g.fillStyle = color; g.font = 'bold 46px Arial, sans-serif'; g.fillText(short || '', 128, 190);
  }, 256, 256, [no, short, color]);
  const badge = useTex((g, w, h) => { g.fillStyle = color; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `bold ${short && short.length > 3 ? 34 : 42}px Arial, sans-serif`; g.fillText(short || '', 64, 35); }, 128, 64, [short, color]);
  useEffect(() => { root.current.traverse((o) => { if (o.isMesh) o.castShadow = true; }); }, []);

  useFrame((state, dt0) => {
    const dt = Math.min(dt0, 0.05), L = live.current, t = state.clock.elapsedTime + index * 1.7, now = performance.now() / 1000;
    let r;
    if (item === 'paddle') { st.r = damp(st.r, L.target ? 1 : 0, L.target ? 9 : 6, dt); r = st.r; }
    else {
      if (st.seen === undefined) st.seen = L.strikeKey; else if (L.strikeKey !== st.seen) { st.seen = L.strikeKey; st.gStart = now; }   // new sale/unsold => gavel
      r = gavelAmount(now - st.gStart) * 0.8;
    }
    // idle life
    body.current.scale.y = 1 + Math.sin(t * 1.6) * 0.012;
    root.current.rotation.y = Math.sin(t * 0.45) * 0.04;
    root.current.rotation.z = Math.sin(t * 0.8) * 0.008 - 0.02 * r;
    const aim = item === 'paddle' ? AUC : L.lookAt;   // owners watch the auctioneer; the auctioneer watches the latest bidder
    const want = aim ? clamp(wrap(Math.atan2(aim.x - pos.x, aim.z - pos.z) - yaw), -1.1, 1.1) : 0;
    st.look = damp(st.look, want, 4, dt);
    head.current.rotation.y = st.look + Math.sin(t * 0.7) * 0.07;
    head.current.rotation.x = Math.sin(t * 0.9) * 0.03 - 0.08 * r;
    if (st.blinkAt < 0 && t > st.nextBlink) st.blinkAt = t;
    let s = 0;
    if (st.blinkAt >= 0) { const k = (t - st.blinkAt) / 0.16; if (k < 1) s = Math.sin(k * Math.PI); else { st.blinkAt = -1; st.nextBlink = t + 2 + Math.random() * 3.5; } }
    for (const l of [lidL.current, lidR.current]) { l.visible = s > 0.04; l.scale.y = Math.max(s, 0.001); }
    // arms
    const a = armPose(r, item);
    armR.current.rotation.set(a.sx, 0, a.sz + Math.sin(t * 9) * 0.03 * (item === 'paddle' ? r : 0));
    elbR.current.rotation.set(a.ex, 0, 0);
    armL.current.rotation.set(-0.15 + Math.sin(t * 0.9) * 0.03, 0, -0.1);
    elbL.current.rotation.set(-0.9 + Math.sin(t * 0.9) * 0.03, 0, 0);
    // held item keeps a world orientation that follows the person's facing (paddle upright, gavel tilting on the strike)
    root.current.getWorldQuaternion(tmp.b);
    handR.current.getWorldQuaternion(tmp.a).invert();
    if (item === 'paddle') tmp.e.set(0, 0, -0.06 + Math.sin(t * 9) * 0.04 * r); else tmp.e.set(lerp(0.9, -0.5, r / 0.8), 0, 0);
    held.current.quaternion.copy(tmp.a).multiply(tmp.b).multiply(tmp.c.setFromEuler(tmp.e));
  });

  const { x: sx, y: sy, upper, fore } = SHOULDER;
  const legX = [-0.1, 0.1];
  return (
    <group position={[pos.x, pos.y || 0, pos.z]} rotation={[0, yaw, 0]}>
      <group ref={root}>
        {seated ? <>
          {/* chair */}
          <mesh position={[0, 0.4, -0.02]} castShadow receiveShadow><boxGeometry args={[0.56, 0.07, 0.56]} /><Mat c="#15161c" r={0.5} /></mesh>
          <mesh position={[0, 0.78, -0.3]} castShadow><boxGeometry args={[0.52, 0.6, 0.07]} /><Mat c="#15161c" r={0.5} /></mesh>
          <mesh position={[0, 0.78, -0.335]}><boxGeometry args={[0.3, 0.05, 0.02]} /><Mat c={color} r={0.4} /></mesh>
          <mesh position={[0, 0.2, -0.02]}><cylinderGeometry args={[0.04, 0.04, 0.4, 8]} /><Mat c="#555" m={0.6} r={0.3} /></mesh>
          <mesh position={[0, 0.02, -0.02]}><cylinderGeometry args={[0.28, 0.28, 0.04, 20]} /><Mat c="#222" /></mesh>
          {legX.map((x) => <group key={x}>
            <mesh position={[x, 0.5, 0.24]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.085, 0.08, 0.5, 14]} /><Mat c="#22252d" /></mesh>
            <mesh position={[x, 0.27, 0.47]}><cylinderGeometry args={[0.07, 0.06, 0.48, 14]} /><Mat c="#22252d" /></mesh>
            <mesh position={[x, 0.04, 0.53]}><boxGeometry args={[0.12, 0.08, 0.27]} /><Mat c="#0d0d0f" r={0.4} m={0.2} /></mesh></group>)}
        </> : legX.map((x) => <group key={x}>
          <mesh position={[x, 0.45, 0]}><cylinderGeometry args={[0.085, 0.07, 0.86, 16]} /><Mat c="#22252d" /></mesh>
          <mesh position={[x, 0.04, 0.05]}><boxGeometry args={[0.13, 0.08, 0.28]} /><Mat c="#0d0d0f" r={0.4} m={0.2} /></mesh></group>)}
        <group position={[0, seated ? -SEAT_DROP : 0, 0]}>
          <group ref={body} position={[0, 0.85, 0]}>
            <mesh position={[0, 0.3, 0]} scale={[1.35, 1, 0.78]}><capsuleGeometry args={[0.19, 0.4, 8, 20]} /><Mat c={suitC} /></mesh>
            <mesh position={[0, 0.5, 0.15]} rotation={[0.1, 0, 0]}><boxGeometry args={[0.14, 0.3, 0.02]} /><Mat c="#f2f2f2" /></mesh>
            <mesh position={[0, 0.44, 0.165]}><boxGeometry args={[0.045, 0.3, 0.015]} /><Mat c={tie} r={0.5} /></mesh>
            {item === 'paddle' && <mesh position={[-0.12, 0.34, 0.152]}><planeGeometry args={[0.12, 0.06]} /><meshBasicMaterial map={badge} /></mesh>}
          </group>
          <mesh position={[0, 1.6, 0]}><cylinderGeometry args={[0.06, 0.065, 0.12, 12]} /><Mat c={skin} /></mesh>
          <group ref={head} position={[0, 1.76, 0]}>
            <mesh scale={[0.95, 1.12, 1]}><sphereGeometry args={[0.14, 32, 24]} /><Mat c={skin} r={0.6} /></mesh>
            <mesh rotation={[-0.45, 0, 0]} scale={[1, 1.06, 1.04]}><sphereGeometry args={[0.15, 32, 20, 0, Math.PI * 2, 0, Math.PI * 0.55]} /><Mat c={hair} r={0.9} /></mesh>
            {[-1, 1].map((d) => <group key={d}>
              <mesh position={[d * 0.05, -0.005, 0.122]}><sphereGeometry args={[0.02, 16, 12]} /><Mat c="#fff" r={0.3} /></mesh>
              <mesh position={[d * 0.05, -0.005, 0.139]}><sphereGeometry args={[0.011, 12, 10]} /><Mat c="#1a120d" r={0.2} /></mesh>
              <mesh ref={d < 0 ? lidL : lidR} position={[d * 0.05, -0.005, 0.124]} visible={false}><sphereGeometry args={[0.0215, 16, 12]} /><Mat c={skin} r={0.6} /></mesh>
              <mesh position={[d * 0.05, 0.035, 0.128]} rotation={[0, 0, d * -0.08]}><boxGeometry args={[0.045, 0.008, 0.01]} /><Mat c={hair} /></mesh>
              <mesh position={[d * 0.133, -0.01, 0]} scale={[0.5, 1, 0.8]}><sphereGeometry args={[0.03, 12, 10]} /><Mat c={skin} /></mesh></group>)}
            <mesh position={[0, -0.03, 0.14]} scale={[0.8, 1.2, 1]}><sphereGeometry args={[0.016, 12, 10]} /><Mat c={skin} /></mesh>
            <mesh position={[0, -0.075, 0.13]}><boxGeometry args={[0.05, 0.007, 0.01]} /><Mat c="#9c4f47" /></mesh>
          </group>
          {/* free arm */}
          <group ref={armL} position={[-sx, sy, 0]}>
            <mesh position={[0, -upper / 2, 0]}><cylinderGeometry args={[0.052, 0.045, upper, 12]} /><Mat c={suitC} /></mesh>
            <group ref={elbL} position={[0, -upper, 0]}>
              <mesh position={[0, -fore / 2, 0]}><cylinderGeometry args={[0.045, 0.038, fore, 12]} /><Mat c={suitC} /></mesh>
              <mesh position={[0, -fore - 0.02, 0]}><sphereGeometry args={[0.04, 14, 12]} /><Mat c={skin} /></mesh></group></group>
          {/* arm that holds the paddle / gavel */}
          <group ref={armR} position={[sx, sy, 0]}>
            <mesh position={[0, -upper / 2, 0]}><cylinderGeometry args={[0.052, 0.045, upper, 12]} /><Mat c={suitC} /></mesh>
            <group ref={elbR} position={[0, -upper, 0]}>
              <mesh position={[0, -fore / 2, 0]}><cylinderGeometry args={[0.045, 0.038, fore, 12]} /><Mat c={suitC} /></mesh>
              <group ref={handR} position={[0, -fore - 0.02, 0]}>
                <mesh><sphereGeometry args={[0.042, 14, 12]} /><Mat c={skin} /></mesh>
                <group ref={held}>
                  {item === 'paddle' ? <>
                    <mesh position={[0, 0.1, 0]}><cylinderGeometry args={[0.014, 0.014, 0.3, 8]} /><Mat c="#6b4a2b" /></mesh>
                    <mesh position={[0, 0.42, 0]}><circleGeometry args={[0.17, 40]} /><meshBasicMaterial map={padTex} toneMapped={false} /></mesh>
                    <mesh position={[0, 0.42, -0.002]} rotation={[0, Math.PI, 0]}><circleGeometry args={[0.17, 40]} /><meshBasicMaterial map={padTex} toneMapped={false} /></mesh>
                  </> : <>
                    <mesh position={[0, 0.1, 0]}><cylinderGeometry args={[0.014, 0.016, 0.26, 8]} /><Mat c="#5a3a1e" r={0.5} /></mesh>
                    <mesh position={[0, 0.24, 0]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.045, 0.045, 0.15, 16]} /><Mat c="#7a4a22" r={0.4} /></mesh>
                  </>}
                </group>
              </group></group></group>
        </group>
      </group>
    </group>
  );
}

// ---------- the hall ----------
function drawLED(g, w, h, d, tall, img) {
  const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#0d1f66'); gr.addColorStop(1, '#050a22'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,138,31,.95)'; g.fillRect(0, 0, w, 14); g.fillRect(0, h - 14, w, 14);
  g.textBaseline = 'middle';
  if (!d || !d.name) {
    g.textAlign = 'center'; g.fillStyle = '#ffd36b'; g.font = `bold ${tall ? 120 : 150}px Impact, "Arial Black", sans-serif`; g.fillText('IPL 2026', w / 2, h * 0.38);
    g.fillStyle = '#fff'; g.font = `bold ${tall ? 66 : 84}px Impact, "Arial Black", sans-serif`; g.fillText('MEGA AUCTION', w / 2, h * 0.64); return;
  }
  const fit = (txt, size, maxW) => { let fs = size; g.font = `bold ${fs}px Impact, "Arial Black", sans-serif`; while (g.measureText(txt).width > maxW && fs > 36) { fs -= 4; g.font = `bold ${fs}px Impact, "Arial Black", sans-serif`; } };
  if (tall) {   // phone layout: everything stacked, nothing at the edges
    g.textAlign = 'center'; g.fillStyle = '#fff'; fit(d.name.toUpperCase(), 92, w - 80); g.fillText(d.name.toUpperCase(), w / 2, 90);
    g.fillStyle = '#ffa447'; g.font = 'bold 34px Arial, sans-serif'; g.fillText(`${String(d.role || '').toUpperCase()}  ·  ${d.country || ''}`, w / 2, 160);
    g.fillStyle = '#fff'; g.font = 'bold 32px Arial, sans-serif'; g.fillText(`BASE  ${cr(d.base)}`, w / 2, 205);
    g.fillStyle = '#9fb0e6'; g.font = 'bold 26px Arial, sans-serif'; g.fillText('CURRENT BID', w / 2, 270);
    g.fillStyle = '#ffb347'; g.font = 'bold 130px Impact, "Arial Black", sans-serif'; g.fillText(d.bidder ? cr(d.bid) : '—', w / 2, 355);
    g.fillStyle = d.bidderColor || '#fff'; fit(d.bidder || 'Awaiting first bid', 44, w - 80); g.fillText(d.bidder || 'Awaiting first bid', w / 2, 440); return;
  }
  const PX = 40, PY = 44, PW = 230, PH = h - 88, TX = 300;   // photo frame on the left, text column on the right
  g.fillStyle = '#1a2a6e'; g.fillRect(PX, PY, PW, PH);
  if (img && img.naturalWidth) {
    const sc = Math.max(PW / img.naturalWidth, PH / img.naturalHeight), sw = PW / sc, sh = PH / sc;
    g.save(); g.beginPath(); g.rect(PX, PY, PW, PH); g.clip();
    g.drawImage(img, (img.naturalWidth - sw) / 2, 0, sw, sh, PX, PY, PW, PH); g.restore();
  } else {
    g.textAlign = 'center'; g.fillStyle = '#ffd36b'; g.font = 'bold 110px Impact, "Arial Black", sans-serif';
    g.fillText(d.name.split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase(), PX + PW / 2, PY + PH / 2);
  }
  g.lineWidth = 6; g.strokeStyle = 'rgba(255,138,31,.95)'; g.strokeRect(PX, PY, PW, PH);
  g.textAlign = 'left'; g.fillStyle = '#fff'; fit(d.name.toUpperCase(), 92, w - TX - 40); g.fillText(d.name.toUpperCase(), TX, 100);
  g.fillStyle = '#ffa447'; g.font = 'bold 38px Arial, sans-serif'; g.fillText(String(d.role || '').toUpperCase(), TX, 170);
  g.fillStyle = '#cfd8f6'; g.font = '32px Arial, sans-serif'; g.fillText(d.country || '', TX, 214);
  g.fillStyle = '#fff'; g.font = 'bold 34px Arial, sans-serif'; g.fillText(`BASE  ${cr(d.base)}`, TX, 258);
  g.fillStyle = '#9fb0e6'; g.font = 'bold 28px Arial, sans-serif'; g.fillText('CURRENT BID', TX, 318);
  g.fillStyle = '#ffb347'; g.font = 'bold 120px Impact, "Arial Black", sans-serif'; g.fillText(d.bidder ? cr(d.bid) : '—', TX, 392);
  g.fillStyle = d.bidderColor || '#fff'; fit(d.bidder || 'Awaiting first bid', 44, w - TX - 40); g.fillText(d.bidder || 'Awaiting first bid', TX, 462);
}

function Audience() {   // two tiered stands on the sides; instanced meshes keep it cheap
  const seats = useMemo(() => {
    const out = []; let k = 11; const rnd = () => { k = (k * 16807) % 2147483647; return k / 2147483647; };
    for (const side of [-1, 1]) for (let row = 0; row < 4; row++) for (let i = 0; i < 14; i++) out.push({ x: side * (9.4 + row * 1.1), y: 0.3 + row * 0.5, z: -7 + i * 1.2, occ: rnd() > 0.25, tone: 0.25 + rnd() * 0.5, side });
    return out;
  }, []);
  const occ = useMemo(() => seats.filter((x) => x.occ), [seats]);
  const a = useRef(), b = useRef(), h = useRef();
  useEffect(() => {
    const m = new THREE.Matrix4(), c = new THREE.Color();
    seats.forEach((s, i) => { m.makeTranslation(s.x, s.y, s.z); a.current.setMatrixAt(i, m); });
    occ.forEach((s, i) => {
      m.makeTranslation(s.x, s.y + 0.42, s.z); b.current.setMatrixAt(i, m); c.setHSL(0.6 + s.tone * 0.1, 0.25, 0.12 + s.tone * 0.18); b.current.setColorAt(i, c);
      m.makeTranslation(s.x, s.y + 0.82, s.z); h.current.setMatrixAt(i, m); c.setHSL(0.07, 0.35, 0.25 + s.tone * 0.2); h.current.setColorAt(i, c);
    });
    [a, b, h].forEach((r) => { r.current.instanceMatrix.needsUpdate = true; if (r.current.instanceColor) r.current.instanceColor.needsUpdate = true; });
  }, [seats, occ]);
  return (<>
    <instancedMesh ref={a} args={[null, null, seats.length]}><boxGeometry args={[0.6, 0.5, 0.7]} /><meshStandardMaterial color="#1a1d33" roughness={0.8} /></instancedMesh>
    <instancedMesh ref={b} args={[null, null, occ.length]}><boxGeometry args={[0.4, 0.5, 0.4]} /><meshStandardMaterial roughness={0.9} /></instancedMesh>
    <instancedMesh ref={h} args={[null, null, occ.length]}><sphereGeometry args={[0.13, 12, 10]} /><meshStandardMaterial roughness={0.7} /></instancedMesh>
    {[-1, 1].map((sd) => [0, 1, 2, 3].map((row) => <mesh key={sd + '-' + row} position={[sd * (9.4 + row * 1.1), 0.05 + row * 0.25, 1.6]} receiveShadow><boxGeometry args={[1.1, 0.1 + row * 0.5, 17]} /><meshStandardMaterial color="#10142c" roughness={0.9} /></mesh>))}
  </>);
}

function Hall({ screen, compact }) {
  const [img, setImg] = useState(null);   // player photo for the LED screen (loaded with CORS so it can be drawn into the texture)
  const photo = screen && screen.photo;
  useEffect(() => {
    setImg(null);
    if (!photo) return undefined;
    let dead = false; const im = new Image(); im.crossOrigin = 'anonymous'; im.referrerPolicy = 'no-referrer';
    im.onload = () => { if (!dead) setImg(im); }; im.src = photo;
    return () => { dead = true; };
  }, [photo]);
  const led = useTex((g, w, h) => drawLED(g, w, h, screen, compact, img), compact ? 640 : 1024, 512, [JSON.stringify(screen || null), compact, img]);
  const LW = compact ? 5.6 : 9;
  const deskTex = useTex((g, w, h) => { g.fillStyle = '#3a210f'; g.fillRect(0, 0, w, h); g.fillStyle = '#ffd36b'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = 'bold 64px Impact, sans-serif'; g.fillText('IPL AUCTION', w / 2, h / 2); }, 512, 128, []);
  const AY = STAGE_Y;
  return (<>
    <color attach="background" args={['#050a22']} />
    {/* floor + carpet */}
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={[60, 60]} /><meshStandardMaterial color="#0a0f28" roughness={0.4} metalness={0.35} /></mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0.5]} receiveShadow><planeGeometry args={[16.4, 22]} /><meshStandardMaterial color="#c9a24a" roughness={0.6} /></mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.008, 0.5]} receiveShadow><planeGeometry args={[16, 21.6]} /><meshStandardMaterial color="#0f1a40" roughness={0.95} /></mesh>
    {/* walls */}
    <mesh position={[0, 5, -12]}><planeGeometry args={[40, 14]} /><meshStandardMaterial color="#070b22" roughness={1} /></mesh>
    {[-1, 1].map((sd) => <mesh key={sd} position={[sd * 16, 5, 0]} rotation={[0, -sd * Math.PI / 2, 0]}><planeGeometry args={[30, 14]} /><meshStandardMaterial color="#080c24" roughness={1} /></mesh>)}
    {/* stage */}
    <mesh position={[0, AY / 2, AUC.z - 0.6]} castShadow receiveShadow><boxGeometry args={[11, AY, 4.2]} /><meshStandardMaterial color="#141a3d" roughness={0.45} metalness={0.2} /></mesh>
    <mesh position={[0, AY + 0.003, AUC.z + 1.5]}><boxGeometry args={[11, 0.05, 0.06]} /><meshBasicMaterial color="#ffb347" /></mesh>
    {/* giant LED screen behind the auctioneer */}
    <mesh position={[0, 3.6, AUC.z - 2.55]}><boxGeometry args={[LW + 0.4, 4.7, 0.2]} /><meshStandardMaterial color="#05060d" roughness={0.5} /></mesh>
    <mesh position={[0, 3.6, AUC.z - 2.44]}><planeGeometry args={[LW, 4.3]} /><meshBasicMaterial map={led} toneMapped={false} /></mesh>
    {[-1, 1].map((sd) => sd * (LW / 2 + 0.7)).map((x) => <mesh key={x} position={[x, 2.6, AUC.z - 2.4]}><boxGeometry args={[0.5, 5.2, 0.4]} /><meshStandardMaterial color="#10142c" roughness={0.6} /></mesh>)}
    {/* podium, mic and gavel block */}
    <mesh position={[AUC.x, AY + 0.45, AUC.z + 0.75]} castShadow><boxGeometry args={[1.9, 0.9, 0.6]} /><meshStandardMaterial color="#3a210f" roughness={0.4} /></mesh>
    <mesh position={[AUC.x, AY + 0.45, AUC.z + 1.056]}><planeGeometry args={[1.7, 0.5]} /><meshBasicMaterial map={deskTex} toneMapped={false} /></mesh>
    <mesh position={[AUC.x + 0.3, AY + 0.93, AUC.z + 0.5]}><cylinderGeometry args={[0.13, 0.15, 0.05, 20]} /><meshStandardMaterial color="#5a3a1e" roughness={0.4} /></mesh>
    <group position={[AUC.x - 0.35, AY + 0.9, AUC.z + 0.85]}>
      <mesh position={[0, 0.15, 0]}><cylinderGeometry args={[0.012, 0.012, 0.3, 8]} /><meshStandardMaterial color="#aaa" metalness={0.8} roughness={0.3} /></mesh>
      <mesh position={[0, 0.34, 0]}><sphereGeometry args={[0.045, 12, 10]} /><meshStandardMaterial color="#222" roughness={0.5} /></mesh></group>
  </>);
}

function Table({ team, leading }) {
  const front = useTex((g, w, h) => { g.fillStyle = team.color; g.fillRect(0, 0, w, h); g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(0, h * 0.62, w, h * 0.38); g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; let fs = 70; g.font = `bold ${fs}px Impact, "Arial Black", sans-serif`; const t = team.name.toUpperCase(); while (g.measureText(t).width > w - 40 && fs > 26) { fs -= 4; g.font = `bold ${fs}px Impact, "Arial Black", sans-serif`; } g.fillText(t, w / 2, h * 0.42); g.font = 'bold 34px Arial, sans-serif'; g.fillText(`PADDLE ${pad(team.no)}`, w / 2, h * 0.82); }, 512, 160, [team.name, team.color, team.no]);
  const scr = useRef();
  useFrame((_, dt) => { if (scr.current) scr.current.emissiveIntensity = damp(scr.current.emissiveIntensity, leading ? 1.8 : 0.3, 6, Math.min(dt, 0.05)); });
  return (<group position={[0, 0, TABLE_FWD]}>
    <mesh position={[0, TABLE_Y, 0]} castShadow receiveShadow><boxGeometry args={[1.9, 0.06, 0.85]} /><meshStandardMaterial color="#3b2212" roughness={0.3} metalness={0.15} /></mesh>
    <mesh position={[0, TABLE_Y - 0.32, 0.405]} castShadow><boxGeometry args={[1.9, 0.6, 0.03]} /><meshStandardMaterial color="#1a1209" roughness={0.6} /></mesh>
    <mesh position={[0, TABLE_Y - 0.3, 0.422]}><planeGeometry args={[1.8, 0.56]} /><meshBasicMaterial map={front} toneMapped={false} /></mesh>
    {[-0.9, 0.9].map((x) => <mesh key={x} position={[x, TABLE_Y / 2 - 0.02, 0]} castShadow><boxGeometry args={[0.05, TABLE_Y - 0.06, 0.8]} /><meshStandardMaterial color="#1a1209" roughness={0.6} /></mesh>)}
    <mesh position={[0, TABLE_Y + 0.17, -0.05]} rotation={[-0.3, Math.PI, 0]}><boxGeometry args={[0.46, 0.28, 0.025]} /><meshStandardMaterial ref={scr} color="#0a0d18" emissive={team.color} emissiveIntensity={0.3} roughness={0.3} /></mesh>
    <mesh position={[0.55, TABLE_Y + 0.07, 0.05]}><cylinderGeometry args={[0.035, 0.035, 0.08, 12]} /><meshStandardMaterial color="#d9d9d9" roughness={0.3} metalness={0.4} /></mesh>
  </group>);
}

function Scene({ teams, curBidder, saleKey, screen, labelRefs }) {
  const { camera, size } = useThree();
  const n = teams.length, compact = size.width / Math.max(size.height, 1) < 1.3, slots = useMemo(() => slotsFor(n, compact ? 0.7 : 1), [n, compact]);
  const idx = teams.findIndex((t) => t.id === curBidder);
  const light = useRef(), v = useMemo(() => new THREE.Vector3(), []), col = useMemo(() => new THREE.Color(), []);

  useEffect(() => {   // wide shot: fit AND centre every table, raised paddles, the stage and the LED screen at any card size / team count
    const t = new THREE.Vector3(0, 1.4, -2), dir = new THREE.Vector3(3, 7.5, 12).normalize(), hw = compact ? 0.62 : 1, lw = compact ? 3.1 : 4.7;
    const pts = [new THREE.Vector3(-5.6 * hw, 0, AUC.z), new THREE.Vector3(5.6 * hw, 0, AUC.z), new THREE.Vector3(-lw, 6, AUC.z - 2.4), new THREE.Vector3(lw, 6, AUC.z - 2.4)];
    slots.forEach((s) => { pts.push(new THREE.Vector3(s.tx - 1, 0, s.tz + 0.5), new THREE.Vector3(s.tx + 1, 0, s.tz + 0.5), new THREE.Vector3(s.x, 2.4, s.z)); });
    const cam = camera.clone(); cam.aspect = size.width / Math.max(size.height, 1); const th = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)); let d = 18;
    const right = new THREE.Vector3(), up = new THREE.Vector3(), tmp = new THREE.Vector3();
    for (let k = 0; k < 16; k++) {
      cam.position.copy(t).addScaledVector(dir, d); cam.lookAt(t); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      let x0 = 9, x1 = -9, y0 = 9, y1 = -9; for (const p of pts) { const q = tmp.copy(p).project(cam); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
      const w = Math.max((x1 - x0) / 2, (y1 - y0) / 2, 0.05), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      right.setFromMatrixColumn(cam.matrixWorld, 0); up.setFromMatrixColumn(cam.matrixWorld, 1);
      t.addScaledVector(right, cx * d * th * cam.aspect * 0.8).addScaledVector(up, cy * d * th * 0.8);   // centre the scene in the frame
      d *= Math.pow(w / 0.92, 0.9);
    }
    camera.position.copy(t).addScaledVector(dir, d); camera.lookAt(t); camera.updateProjectionMatrix();
  }, [camera, size.width, size.height, slots, compact]);

  useFrame((_, dt0) => {
    const dt = Math.min(dt0, 0.05);
    teams.forEach((t, i) => {   // pin the HTML name tags to the 3D tables
      const el = labelRefs.current[t.id]; if (!el) return;
      v.set(slots[i].tx, 1.05, slots[i].tz + 0.45).project(camera);
      el.style.transform = `translate(${((v.x * 0.5 + 0.5) * size.width).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * size.height).toFixed(1)}px) translate(-50%, -100%)`; el.style.opacity = '1';
    });
    const L = light.current; if (!L) return;   // coloured spotlight on whoever leads
    const s = idx >= 0 ? slots[idx] : null;
    if (s) { L.position.x = damp(L.position.x, s.x, 6, dt); L.position.z = damp(L.position.z, s.z, 6, dt); col.set(teams[idx].color); L.color.lerp(col, 1 - Math.exp(-6 * dt)); }
    L.intensity = damp(L.intensity, s ? 22 : 0, 5, dt);
  });

  return (<>
    <ambientLight intensity={0.85} /><hemisphereLight args={['#b8c8ff', '#2a2350', 0.9]} />
    <directionalLight position={[4, 12, 8]} intensity={2.2} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-12} shadow-camera-right={12} shadow-camera-top={12} shadow-camera-bottom={-12} shadow-camera-far={40} shadow-bias={-0.0004} />
    <pointLight position={[0, 6, AUC.z + 1]} intensity={90} color="#ffb347" distance={14} decay={1.6} />
    <pointLight position={[-6, 6, 0]} intensity={30} color="#7aa2ff" distance={16} decay={1.6} /><pointLight position={[6, 6, 0]} intensity={30} color="#7aa2ff" distance={16} decay={1.6} />
    <pointLight ref={light} position={[0, 3, 0]} intensity={0} distance={6} decay={1.5} />
    <Hall screen={screen} compact={compact} /><Audience />
    {teams.map((t, i) => <group key={t.id}>
      <group position={[slots[i].x, 0, slots[i].z]} rotation={[0, slots[i].yaw, 0]}><Table team={t} leading={t.id === curBidder} /></group>
      <Person pos={{ x: slots[i].x, z: slots[i].z }} yaw={slots[i].yaw} seated item="paddle" index={i} skin={SKINS[i % 5]} hair={HAIRS[(i * 3) % 5]} suit={new THREE.Color(t.color).multiplyScalar(0.4).getStyle()} tie={t.color} color={t.color} no={t.no} short={abbr(t.name)} target={t.id === curBidder} /></group>)}
    <Person pos={{ x: AUC.x, y: STAGE_Y, z: AUC.z }} yaw={0} item="gavel" index={7} skin={SKINS[2]} hair={HAIRS[2]} suit="#25262e" tie="#ffb347" color="#ffb347" strikeKey={saleKey} lookAt={idx >= 0 ? { x: slots[idx].x, z: slots[idx].z } : null} />
  </>);
}

/**
 * teams: [{id, name, color, no, owner, purse, squad}] in room order.  curBidder: franchise id of the highest bidder (null = none).
 * curBid: its amount in lakh.  saleKey: changes when a player is sold/unsold (triggers the gavel).
 * screen: data for the LED screen {name, role, country, base, bid, bidder, bidderColor}.  panel: compact info node for phones.
 */
export default function BidderStage({ teams = [], curBidder = null, curBid = 0, saleKey = '', screen = null, panel = null, controls = null, className = 'h-[500px] sm:h-[560px] lg:h-[calc(100vh-170px)] lg:min-h-[560px]' }) {
  const [ok, setOk] = useState(false);
  const labelRefs = useRef({});
  useEffect(() => { try { const c = document.createElement('canvas'); setOk(!!(c.getContext('webgl2') || c.getContext('webgl'))); } catch (e) { setOk(false); } }, []);
  if (!ok || !teams.length) return null;   // no WebGL: the normal auction screen still works
  return (<div className="card relative select-none overflow-hidden" style={{ padding: 0 }}>
    <div className={className} style={{ touchAction: 'pan-y' }}>
      <Canvas shadows dpr={[1, 1.75]} camera={{ fov: 34, position: [0, 9, 16] }} gl={{ antialias: true }}>
        <Scene teams={teams} curBidder={curBidder} saleKey={saleKey} screen={screen} labelRefs={labelRefs} />
      </Canvas>
    </div>
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {teams.map((t) => { const lead = t.id === curBidder; return (
        <div key={t.id} ref={(el) => { labelRefs.current[t.id] = el; }} className="absolute left-0 top-0" style={{ opacity: 0, willChange: 'transform' }}>
          <div className="flex flex-col items-center gap-0.5">
            {lead && <div key={curBid} className="pop rounded-full px-2 py-0.5 text-sm font-extrabold text-white shadow-lg sm:text-base" style={{ background: t.color, boxShadow: `0 0 16px ${t.color}` }}>{cr(curBid)}</div>}
            <div className="flex items-center gap-1 rounded-lg border bg-black/70 px-1 py-0.5 text-[10px] backdrop-blur sm:gap-1.5 sm:px-1.5 sm:text-xs" style={{ borderColor: lead ? t.color : 'rgba(255,255,255,.18)', boxShadow: lead ? `0 0 14px ${t.color}` : 'none' }}>
              <Logo team={t.name} size={20} />
              <div className="leading-tight"><div className="font-bold uppercase">{abbr(t.name)} <span className="rounded bg-white px-1 text-black">#{pad(t.no)}</span></div>
                {t.owner ? <div className="hidden max-w-[90px] truncate text-slate-300 sm:block">{t.owner}</div> : null}
                {t.purse != null ? <div className="hidden text-[10px] text-amber-300 sm:block">{cr(t.purse)} · {t.squad ?? 0} players</div> : null}</div>
            </div>
          </div>
        </div>); })}
    </div>
    {panel && <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 lg:left-3 lg:translate-x-0">{panel}</div>}
    {controls && <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2">{controls}</div>}
  </div>);
}
