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

export const SEAT_R = 2.05, TABLE_R = 1.5, TABLE_Y = 0.78, SEAT_DROP = 0.35;
export const AUC = { x: 0, z: -4.6 };                    // auctioneer's position (front of the hall)
export const SHOULDER = { x: 0.3, y: 1.43, upper: 0.3, fore: 0.27 };
// arm poses: [shoulder x, shoulder z, elbow x]; r = 0 resting, 1 = fully raised
const REST = { paddle: [-0.45, 0.12, -1.42], gavel: [-0.35, 0.12, -1.3] }, UP = [0.2, 2.9, -0.25];
export const armPose = (r, item = 'paddle') => { const a = REST[item]; return { sx: lerp(a[0], UP[0], r), sz: lerp(a[1], UP[1], r), ex: lerp(a[2], UP[2], r) }; };
export const gavelAmount = (s) => { if (s < 0 || s >= 0.95) return 0; const ph = (s % 0.475) / 0.475; return ph < 0.55 ? smooth(ph / 0.55) : 1 - smooth((ph - 0.55) / 0.45); };
export const seatAt = (i, n) => { const a = (2 * Math.PI * i) / n + Math.PI / (2 * n); return { a, x: SEAT_R * Math.sin(a), z: SEAT_R * Math.cos(a), yaw: a + Math.PI }; };   // 120 deg apart for 3, 90 for 4 ...

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

// ---------- the room ----------
function Hall({ n }) {
  const wall = useTex((g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#0a1233'); gr.addColorStop(0.5, '#16286b'); gr.addColorStop(1, '#0a1233'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,138,31,.9)'; g.fillRect(0, h * 0.82, w, 8);
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#ffd36b'; g.font = 'bold 150px Impact, "Arial Black", sans-serif'; g.fillText('IPL 2026 AUCTION', w / 2, h * 0.42);
    g.fillStyle = '#fff'; g.font = 'bold 44px Arial, sans-serif'; g.fillText('FRIENDS  EDITION', w / 2, h * 0.68);
  }, 1536, 384, []);
  const top = useTex((g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w / 2); gr.addColorStop(0, '#6a3f1f'); gr.addColorStop(1, '#2a170b'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 2; for (let i = 0; i < 40; i++) { g.beginPath(); g.arc(w / 2, h / 2, 20 + i * 11, 0, Math.PI * 2); g.stroke(); }
    g.strokeStyle = '#e0b24a'; g.lineWidth = 6; g.beginPath(); g.arc(w / 2, h / 2, w * 0.4, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(w / 2, h / 2, w * 0.36, 0, Math.PI * 2); g.lineWidth = 2; g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#ffd36b'; g.font = 'bold 120px Impact, "Arial Black", sans-serif'; g.fillText('IPL', w / 2, h / 2 - 30);
    g.fillStyle = '#fff'; g.font = 'bold 40px Arial, sans-serif'; g.fillText('2026 AUCTION', w / 2, h / 2 + 50);
  }, 512, 512, []);
  const deskTex = useTex((g, w, h) => { g.fillStyle = '#3a210f'; g.fillRect(0, 0, w, h); g.fillStyle = '#ffd36b'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = 'bold 64px Impact, sans-serif'; g.fillText('IPL AUCTION', w / 2, h / 2); }, 512, 128, []);
  return (<>
    <color attach="background" args={['#070d24']} /><fog attach="fog" args={['#070d24', 15, 28]} />
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow><circleGeometry args={[12, 64]} /><meshStandardMaterial color="#0b1230" roughness={0.35} metalness={0.3} /></mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]} receiveShadow><circleGeometry args={[3.5, 64]} /><meshStandardMaterial color="#13204f" roughness={0.9} /></mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.008, 0]}><ringGeometry args={[3.5, 3.56, 64]} /><meshBasicMaterial color="#ffb347" /></mesh>
    <mesh position={[0, 3.2, -7.5]}><planeGeometry args={[18, 4.5]} /><meshBasicMaterial map={wall} toneMapped={false} /></mesh>
    {[-7, -4.2, -1.4, 1.4, 4.2, 7].map((x) => <mesh key={x} position={[x, 5.3, -6.8]}><sphereGeometry args={[0.16, 12, 10]} /><meshBasicMaterial color="#ffe9b0" /></mesh>)}
    {/* table */}
    <mesh position={[0, TABLE_Y - 0.04, 0]} castShadow receiveShadow><cylinderGeometry args={[TABLE_R, TABLE_R, 0.08, 64]} /><meshStandardMaterial color="#3b2212" roughness={0.3} metalness={0.15} /></mesh>
    <mesh position={[0, TABLE_Y + 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[TABLE_R - 0.02, 64]} /><meshStandardMaterial map={top} roughness={0.25} metalness={0.1} /></mesh>
    <mesh position={[0, TABLE_Y - 0.04, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[TABLE_R, 0.03, 12, 80]} /><meshStandardMaterial color="#e0b24a" metalness={0.8} roughness={0.3} /></mesh>
    <mesh position={[0, TABLE_Y / 2 - 0.04, 0]} castShadow><cylinderGeometry args={[0.28, 0.5, TABLE_Y - 0.08, 24]} /><meshStandardMaterial color="#1c1009" roughness={0.5} /></mesh>
    {/* auctioneer podium + desk */}
    <mesh position={[AUC.x, 0.15, AUC.z]} castShadow receiveShadow><boxGeometry args={[3.4, 0.3, 1.8]} /><meshStandardMaterial color="#1a1f3a" roughness={0.5} /></mesh>
    <mesh position={[AUC.x, 0.3 + 0.45, AUC.z + 0.6]} castShadow><boxGeometry args={[1.9, 0.9, 0.5]} /><meshStandardMaterial color="#3a210f" roughness={0.4} /></mesh>
    <mesh position={[AUC.x, 0.3 + 0.45, AUC.z + 0.855]}><planeGeometry args={[1.7, 0.42]} /><meshBasicMaterial map={deskTex} toneMapped={false} /></mesh>
    <mesh position={[AUC.x + 0.45, 0.3 + 0.92, AUC.z + 0.6]}><cylinderGeometry args={[0.14, 0.16, 0.05, 20]} /><meshStandardMaterial color="#5a3a1e" roughness={0.4} /></mesh>
  </>);
}

function Nameplate({ s, color, leading }) {
  const mat = useRef();
  useFrame((_, dt) => { if (mat.current) mat.current.emissiveIntensity = damp(mat.current.emissiveIntensity, leading ? 1.6 : 0.25, 6, Math.min(dt, 0.05)); });
  const x = s.x * 0.6, z = s.z * 0.6;
  return (<group position={[x, TABLE_Y + 0.17, z]} rotation={[0, s.yaw, 0]}>
    <mesh rotation={[-0.35, 0, 0]}><boxGeometry args={[0.5, 0.26, 0.03]} /><meshStandardMaterial ref={mat} color="#0a0d18" emissive={color} emissiveIntensity={0.25} roughness={0.3} /></mesh>
  </group>);
}

function Scene({ teams, curBidder, saleKey, labelRefs }) {
  const { camera, size } = useThree();
  const n = teams.length, seats = useMemo(() => teams.map((_, i) => seatAt(i, n)), [n]); // eslint-disable-line react-hooks/exhaustive-deps
  const idx = teams.findIndex((t) => t.id === curBidder);
  const light = useRef(), v = useMemo(() => new THREE.Vector3(), []), col = useMemo(() => new THREE.Color(), []);

  useEffect(() => {   // frame the whole room (all seats, raised paddles, auctioneer + room for the info panel) at any card size / team count
    const t = new THREE.Vector3(0, 0.9, -1.2), dir = new THREE.Vector3(0, 5.9, 8.6).normalize(), pts = [new THREE.Vector3(-1.8, 0, AUC.z), new THREE.Vector3(1.8, 0, AUC.z), new THREE.Vector3(0, 3.6, AUC.z)];
    seats.forEach((s) => { pts.push(new THREE.Vector3(s.x * 1.15, 0, s.z * 1.15), new THREE.Vector3(s.x, 2.3, s.z)); });
    const cam = camera.clone(); cam.aspect = size.width / Math.max(size.height, 1); let d = 12;
    for (let k = 0; k < 12; k++) {
      cam.position.copy(t).addScaledVector(dir, d); cam.lookAt(t); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      let w = 0; for (const p of pts) { const v = p.clone().project(cam); w = Math.max(w, Math.abs(v.x), Math.abs(v.y)); }
      d *= Math.pow(w / 0.9, 0.9);
    }
    camera.position.copy(t).addScaledVector(dir, d); camera.lookAt(t); camera.updateProjectionMatrix();
  }, [camera, size.width, size.height, seats]);

  useFrame((_, dt0) => {
    const dt = Math.min(dt0, 0.05);
    teams.forEach((t, i) => {   // pin the HTML name tags to the 3D seats
      const el = labelRefs.current[t.id]; if (!el) return;
      v.set(seats[i].x * 0.58, 1.0, seats[i].z * 0.58).project(camera);
      el.style.transform = `translate(${((v.x * 0.5 + 0.5) * size.width).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * size.height).toFixed(1)}px) translate(-50%, -100%)`; el.style.opacity = '1';
    });
    const L = light.current; if (!L) return;   // coloured spotlight on whoever leads
    const s = idx >= 0 ? seats[idx] : null;
    if (s) { L.position.x = damp(L.position.x, s.x, 6, dt); L.position.z = damp(L.position.z, s.z, 6, dt); col.set(teams[idx].color); L.color.lerp(col, 1 - Math.exp(-6 * dt)); }
    L.intensity = damp(L.intensity, s ? 16 : 0, 5, dt);
  });

  return (<>
    <ambientLight intensity={0.55} /><hemisphereLight args={['#9db4ff', '#1a1330', 0.45]} />
    <directionalLight position={[3, 9, 6]} intensity={1.5} castShadow shadow-mapSize={[1024, 1024]} shadow-camera-left={-7} shadow-camera-right={7} shadow-camera-top={7} shadow-camera-bottom={-7} shadow-bias={-0.0004} />
    <pointLight position={[0, 3, -5]} intensity={20} color="#ffb347" />
    <pointLight ref={light} position={[0, 2.6, 0]} intensity={0} distance={5} decay={1.6} />
    <Hall n={n} />
    {teams.map((t, i) => <group key={t.id}>
      <Person pos={{ x: seats[i].x, z: seats[i].z }} yaw={seats[i].yaw} seated item="paddle" index={i} skin={SKINS[i % 5]} hair={HAIRS[(i * 3) % 5]} suit={new THREE.Color(t.color).multiplyScalar(0.4).getStyle()} tie={t.color} color={t.color} no={t.no} short={abbr(t.name)} target={t.id === curBidder} />
      <Nameplate s={seats[i]} color={t.color} leading={t.id === curBidder} /></group>)}
    <Person pos={{ x: AUC.x, y: 0.3, z: AUC.z - 0.1 }} yaw={0} item="gavel" index={7} skin={SKINS[2]} hair={HAIRS[2]} suit="#25262e" tie="#ffb347" color="#ffb347" strikeKey={saleKey} lookAt={idx >= 0 ? seats[idx] : null} />
  </>);
}

/**
 * teams: [{id, name, color, no, owner}] in room order.  curBidder: franchise id of the highest bidder (null = none).
 * curBid: its amount in lakh.  saleKey: changes when a player is sold/unsold (triggers the gavel).  panel: auctioneer info node.
 */
export default function BidderStage({ teams = [], curBidder = null, curBid = 0, saleKey = '', panel = null, className = 'h-[360px] sm:h-[440px] lg:h-[540px]' }) {
  const [ok, setOk] = useState(false);
  const labelRefs = useRef({});
  useEffect(() => { try { const c = document.createElement('canvas'); setOk(!!(c.getContext('webgl2') || c.getContext('webgl'))); } catch (e) { setOk(false); } }, []);
  if (!ok || !teams.length) return null;   // no WebGL: the normal auction screen still works
  return (<div className="card relative select-none overflow-hidden" style={{ padding: 0 }}>
    <div className={className} style={{ touchAction: 'pan-y' }}>
      <Canvas shadows dpr={[1, 2]} camera={{ fov: 36, position: [0, 6.6, 7.4] }} gl={{ antialias: true }}>
        <Scene teams={teams} curBidder={curBidder} saleKey={saleKey} labelRefs={labelRefs} />
      </Canvas>
    </div>
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {teams.map((t) => { const lead = t.id === curBidder; return (
        <div key={t.id} ref={(el) => { labelRefs.current[t.id] = el; }} className="absolute left-0 top-0" style={{ opacity: 0, willChange: 'transform' }}>
          <div className="flex flex-col items-center gap-0.5">
            {lead && <div key={curBid} className="pop rounded-full px-2 py-0.5 text-sm font-extrabold text-white shadow-lg sm:text-base" style={{ background: t.color, boxShadow: `0 0 16px ${t.color}` }}>{cr(curBid)}</div>}
            <div className="flex items-center gap-1 rounded-lg border bg-black/70 px-1 py-0.5 text-[10px] backdrop-blur sm:gap-1.5 sm:px-1.5 sm:text-xs" style={{ borderColor: lead ? t.color : 'rgba(255,255,255,.18)', boxShadow: lead ? `0 0 14px ${t.color}` : 'none' }}>
              <Logo team={t.name} size={20} />
              <div className="leading-tight"><div className="font-bold uppercase">{abbr(t.name)}</div>{t.owner ? <div className="hidden max-w-[84px] truncate text-slate-300 sm:block">{t.owner}</div> : null}</div>
              <b className="rounded bg-white px-1 text-black">#{pad(t.no)}</b>
            </div>
          </div>
        </div>); })}
    </div>
    {panel && <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2">{panel}</div>}
  </div>);
}
