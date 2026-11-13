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
const SLOTS = [[-5.6, -2.9], [5.6, -2.9], [0, 3.6], [-2.8, 0.3], [2.8, 0.3], [-6.7, 3.1], [6.7, 3.1], [-3.6, 6.0], [3.6, 6.0], [0, 8.3]];
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
function Person({ pos, yaw, scale = 1, shadow = true, seated, item, skin, hair, suit, tie, index, target, no, short, color, strikeKey, lookAt }) {
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
  useEffect(() => { root.current.traverse((o) => { if (o.isMesh) o.castShadow = shadow; }); }, [shadow]);

  useFrame((state, dt0) => {
    const dt = Math.min(dt0, 0.05), L = live.current, t = state.clock.elapsedTime + index * 1.7, now = performance.now() / 1000;
    let r;
    if (item === 'paddle') { st.r = damp(st.r, L.target ? 1 : 0, L.target ? 9 : 6, dt); r = st.r; }
    else if (item === 'idle') r = 0;   // franchise team members: seated, watching the auctioneer, never bid
    else {
      if (st.seen === undefined) st.seen = L.strikeKey; else if (L.strikeKey !== st.seen) { st.seen = L.strikeKey; st.gStart = now; }   // new sale/unsold => gavel
      r = gavelAmount(now - st.gStart) * 0.8;
    }
    // idle life
    body.current.scale.y = 1 + Math.sin(t * 1.6) * 0.012;
    root.current.rotation.y = Math.sin(t * 0.45) * 0.04;
    root.current.rotation.z = Math.sin(t * 0.8) * 0.008 - 0.02 * r;
    const aim = item === 'gavel' ? L.lookAt : AUC;   // owners watch the auctioneer; the auctioneer watches the latest bidder
    const want = aim ? clamp(wrap(Math.atan2(aim.x - pos.x, aim.z - pos.z) - yaw), -1.1, 1.1) : 0;
    st.look = damp(st.look, want, 4, dt);
    head.current.rotation.y = st.look + Math.sin(t * 0.7) * 0.07;
    head.current.rotation.x = Math.sin(t * 0.9) * 0.03 - 0.08 * r;
    if (st.blinkAt < 0 && t > st.nextBlink) st.blinkAt = t;
    let s = 0;
    if (st.blinkAt >= 0) { const k = (t - st.blinkAt) / 0.16; if (k < 1) s = Math.sin(k * Math.PI); else { st.blinkAt = -1; st.nextBlink = t + 2 + Math.random() * 3.5; } }
    for (const l of [lidL.current, lidR.current]) { l.visible = s > 0.04; l.scale.y = Math.max(s, 0.001); }
    // arms
    const a = armPose(r, item === 'idle' ? 'paddle' : item);
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
    <group position={[pos.x, pos.y || 0, pos.z]} rotation={[0, yaw, 0]} scale={scale}>
      <group ref={root}>
        {seated ? <>
          {/* chair */}
          <mesh position={[0, 0.4, -0.02]} castShadow receiveShadow><boxGeometry args={[0.56, 0.07, 0.56]} /><Mat c="#15161c" r={0.5} /></mesh>
          <mesh position={[0, 0.78, -0.3]} castShadow><boxGeometry args={[0.52, 0.6, 0.07]} /><Mat c="#15161c" r={0.5} /></mesh>
          <mesh position={[0, 0.78, -0.335]}><boxGeometry args={[0.3, 0.05, 0.02]} /><Mat c={color} r={0.4} /></mesh>
          {[-0.3, 0.3].map((x) => <mesh key={x} position={[x, 0.62, 0.02]}><boxGeometry args={[0.05, 0.04, 0.34]} /><Mat c="#15161c" r={0.5} /></mesh>)}
          {[-0.3, 0.3].map((x) => <mesh key={'a' + x} position={[x, 0.52, -0.1]}><boxGeometry args={[0.04, 0.2, 0.04]} /><Mat c="#15161c" r={0.5} /></mesh>)}
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
            {item !== 'gavel' && <mesh position={[-0.12, 0.34, 0.152]}><planeGeometry args={[0.12, 0.06]} /><meshBasicMaterial map={badge} /></mesh>}
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
                  {item === 'idle' ? null : item === 'paddle' ? <>
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
const IMPACT = 'Impact, "Arial Black", sans-serif';
const rr = (g, x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
const fitFont = (g, txt, size, maxW, min = 26, fam = IMPACT) => { let fs = size; g.font = `bold ${fs}px ${fam}`; while (g.measureText(txt).width > maxW && fs > min) { fs -= 3; g.font = `bold ${fs}px ${fam}`; } return fs; };

// Broadcast-style LED graphic. d = { name, photo, role, country, overseas, capped, base, bid, bidder, bidderColor, stats[], secs, paused, lot }
function drawLED(g, w, h, d, tall, img) {
  const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#0b1a5c'); gr.addColorStop(0.6, '#07103a'); gr.addColorStop(1, '#040818'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,138,31,.07)'; g.lineWidth = 26; for (let x = -h; x < w + h; x += 120) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + h, 0); g.stroke(); }
  const bar = tall ? 46 : 60;
  g.fillStyle = '#ff8a1f'; g.fillRect(0, 0, w, bar);
  g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = '#071033'; g.font = `bold ${tall ? 28 : 36}px ${IMPACT}`; g.fillText('IPL 2026  ·  MEGA AUCTION', 24, bar / 2 + 2);
  g.textAlign = 'right'; g.fillText(d && d.lot ? `${d.lot}   ● LIVE` : '● LIVE', w - 24, bar / 2 + 2);
  g.fillStyle = '#ff8a1f'; g.fillRect(0, h - 10, w, 10);
  if (!d || !d.name) {
    g.textAlign = 'center'; g.fillStyle = '#ffd36b'; g.font = `bold ${tall ? 130 : 190}px ${IMPACT}`; g.fillText('IPL 2026', w / 2, h * 0.42);
    g.fillStyle = '#fff'; g.font = `bold ${tall ? 70 : 100}px ${IMPACT}`; g.fillText('MEGA AUCTION', w / 2, h * 0.68); return;
  }
  const chip = (txt, x, y, bg, fg, size) => { g.font = `bold ${size}px Arial, sans-serif`; const tw = g.measureText(txt).width + 26; g.fillStyle = bg; rr(g, x, y, tw, size + 16, 8); g.fill(); g.fillStyle = fg; g.textAlign = 'left'; g.fillText(txt, x + 13, y + (size + 16) / 2 + 1); return tw + 10; };
  const photo = (x, y, pw, ph) => {
    g.fillStyle = '#16257a'; g.fillRect(x, y, pw, ph);
    if (img && img.naturalWidth) { const sc = Math.max(pw / img.naturalWidth, ph / img.naturalHeight), sw = pw / sc, sh = ph / sc; g.save(); g.beginPath(); g.rect(x, y, pw, ph); g.clip(); g.drawImage(img, (img.naturalWidth - sw) / 2, 0, sw, sh, x, y, pw, ph); g.restore(); }
    else { g.textAlign = 'center'; g.fillStyle = '#ffd36b'; g.font = `bold ${Math.round(pw * 0.42)}px ${IMPACT}`; g.fillText(d.name.split(' ').map((q) => q[0]).slice(0, 2).join('').toUpperCase(), x + pw / 2, y + ph / 2); }
    g.lineWidth = 6; g.strokeStyle = '#ff8a1f'; g.strokeRect(x, y, pw, ph);
  };
  const ring = (cx, cy, rad) => {
    if (d.secs == null && !d.paused) return;
    g.lineWidth = 10; g.strokeStyle = d.paused ? '#9fb0e6' : d.secs <= 5 ? '#ef4444' : '#ffb347'; g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.stroke();
    g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = `bold ${Math.round(rad * 1.05)}px ${IMPACT}`; g.fillText(d.paused ? 'II' : String(d.secs), cx, cy + 3);
  };
  const tag = d.overseas ? ['#38bdf8', `✈ ${d.country || 'OVERSEAS'}`] : ['#22c55e', 'INDIAN'];
  if (tall) {   // phone layout 800 x 640
    photo(28, 70, 190, 240);
    g.textAlign = 'left'; g.fillStyle = '#fff'; fitFont(g, d.name.toUpperCase(), 78, w - 260); g.fillText(d.name.toUpperCase(), 244, 110);
    let x = 244; x += chip(String(d.role || '').toUpperCase(), x, 150, '#fbbf24', '#111', 24); chip(tag[1].toUpperCase(), x, 150, tag[0], '#111', 24);
    g.fillStyle = '#cfd8f6'; g.font = '26px Arial, sans-serif'; g.textAlign = 'left'; g.fillText((d.stats || []).slice(0, 2).join('  •  '), 244, 235);
    g.fillStyle = '#fff'; g.font = 'bold 30px Arial, sans-serif'; g.fillText(`BASE  ${cr(d.base)}`, 244, 285);
    g.fillStyle = '#9fb0e6'; g.font = 'bold 24px Arial, sans-serif'; g.textAlign = 'center'; g.fillText('CURRENT BID', w / 2, 352);
    g.fillStyle = '#ffb347'; g.font = `bold 140px ${IMPACT}`; g.fillText(d.bidder ? cr(d.bid) : '—', w / 2, 440);
    g.fillStyle = d.bidderColor || '#fff'; fitFont(g, d.bidder || 'Awaiting first bid', 50, w - 200); g.fillText(d.bidder || 'Awaiting first bid', w / 2 - 40, 530);
    ring(w - 90, 520, 44); return;
  }
  photo(48, 96, 330, h - 96 - 40);   // landscape 1280 x 640
  const TX = 420;
  g.textAlign = 'left'; g.fillStyle = '#fff'; fitFont(g, d.name.toUpperCase(), 108, w - TX - 48); g.fillText(d.name.toUpperCase(), TX, 170);
  let x = TX; x += chip(String(d.role || '').toUpperCase(), x, 226, '#fbbf24', '#111', 30); x += chip(tag[1].toUpperCase(), x, 226, tag[0], '#111', 30);
  x += chip(d.capped === 'Capped' ? 'CAPPED' : 'UNCAPPED', x, 226, d.capped === 'Capped' ? '#a855f7' : '#64748b', '#fff', 30);
  g.fillStyle = '#cfd8f6'; fitFont(g, (d.stats || []).join('   •   '), 32, w - TX - 48 - 110, 20, 'Arial, sans-serif'); g.font = g.font.replace('bold ', ''); g.fillText((d.stats || []).join('   •   '), TX, 318);
  g.fillStyle = '#9fb0e6'; g.font = 'bold 26px Arial, sans-serif'; g.fillText('BASE PRICE', TX, 372); g.fillStyle = '#fff'; g.font = `bold 44px ${IMPACT}`; g.fillText(cr(d.base), TX + 170, 370);
  g.fillStyle = 'rgba(2,6,24,.78)'; rr(g, TX, 410, w - TX - 48, 190, 14); g.fill();
  g.fillStyle = d.bidderColor || '#ff8a1f'; g.fillRect(TX, 410, 12, 190);
  g.fillStyle = '#9fb0e6'; g.font = 'bold 26px Arial, sans-serif'; g.fillText('CURRENT BID', TX + 40, 446);
  g.fillStyle = '#ffb347'; fitFont(g, d.bidder ? cr(d.bid) : '—', 124, 400); g.fillText(d.bidder ? cr(d.bid) : '—', TX + 40, 535);
  g.fillStyle = '#9fb0e6'; g.font = 'bold 26px Arial, sans-serif'; g.fillText('HIGHEST BIDDER', 890, 446);
  g.fillStyle = d.bidderColor || '#fff'; fitFont(g, d.bidder || 'Awaiting first bid', 46, 320); g.fillText(d.bidder || 'Awaiting first bid', 890, 500);
  ring(w - 48 - 40, 366, 36);
}

function drawResult(g, w, h, r) {
  const sold = r.status === 'sold', col = sold ? '#22c55e' : '#ef4444';
  g.fillStyle = 'rgba(3,7,24,.96)'; g.fillRect(0, 0, w, h);
  g.fillStyle = r.color || col; g.fillRect(0, 0, w, 20); g.fillRect(0, h - 20, w, 20);
  g.lineWidth = 10; g.strokeStyle = col; g.strokeRect(5, 5, w - 10, h - 10);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = col; g.font = `bold ${sold ? 190 : 150}px ${IMPACT}`; g.fillText(sold ? 'SOLD!' : 'UNSOLD', w / 2, 140);
  g.fillStyle = '#fff'; fitFont(g, String(r.player || '').toUpperCase(), 66, w - 120); g.fillText(String(r.player || '').toUpperCase(), w / 2, 260);
  if (sold) {
    g.fillStyle = r.color || '#fff'; fitFont(g, String(r.team || ''), 56, w - 120); g.fillText(String(r.team || ''), w / 2, 340);
    g.fillStyle = '#ffb347'; g.font = `bold 120px ${IMPACT}`; g.fillText(cr(r.price), w / 2, 435);
  } else { g.fillStyle = '#cfd8f6'; g.font = 'bold 54px Arial, sans-serif'; g.fillText('NO TEAM BOUGHT THIS PLAYER', w / 2, 370); }
}

// pop-in SOLD / UNSOLD card on the giant LED screen. Only mounted for a few seconds after the SERVER confirmed the result.
function ResultCard({ r, LW }) {
  const tex = useTex((g, w, h) => drawResult(g, w, h, r), 1024, 512, [r.key]);
  const m = useRef(), mat = useRef(), t0 = useRef(performance.now());
  useFrame(() => {
    const a = (performance.now() - t0.current) / 1000, s = a < 0.5 ? 0.55 + 0.45 * (1 + 2.2 * Math.pow(a / 0.5 - 1, 3) + 1.2 * Math.pow(a / 0.5 - 1, 2)) : 1;
    const op = a < 0.2 ? a / 0.2 : a > 3.9 ? Math.max(0, 1 - (a - 3.9) / 0.6) : 1;
    if (m.current) m.current.scale.set(s, s, 1); if (mat.current) mat.current.opacity = op;
  });
  return <mesh ref={m} position={[0, 3.95, AUC.z - 2.4]} renderOrder={5}><planeGeometry args={[LW * 0.78, LW * 0.39]} /><meshBasicMaterial ref={mat} map={tex} transparent toneMapped={false} depthWrite={false} /></mesh>;
}

// orange swipe across the screen whenever a new player comes on the block
function Wipe({ k, LW, LH }) {
  const m = useRef(), t0 = useRef(-10), seen = useRef(k);
  useFrame(() => {
    if (seen.current !== k) { seen.current = k; t0.current = performance.now(); }
    const a = (performance.now() - t0.current) / 1000;
    if (!m.current) return;
    if (a > 0.75) { m.current.visible = false; return; }
    m.current.visible = true; const p = a / 0.75; m.current.position.x = lerp(-LW * 0.9, LW * 0.9, smooth(p));
  });
  return <mesh ref={m} position={[0, 3.95, AUC.z - 2.42]} visible={false} renderOrder={4}><planeGeometry args={[LW * 0.45, LH]} /><meshBasicMaterial color="#ff8a1f" transparent opacity={0.9} toneMapped={false} depthWrite={false} /></mesh>;
}

function TVCam({ x, z, focus }) {
  const head = useRef(), tally = useRef();
  useFrame((_, dt) => {
    const f = focus.current, want = Math.atan2(f.x - x, f.z - z);
    head.current.rotation.y = head.current.rotation.y + wrap(want - head.current.rotation.y) * (1 - Math.exp(-2.5 * Math.min(dt, 0.05)));
    tally.current.visible = Math.floor(performance.now() / 700) % 2 === 0;
  });
  return (<group position={[x, 0, z]}>
    {[0, 2.1, 4.2].map((a) => <mesh key={a} position={[Math.sin(a) * 0.28, 0.65, Math.cos(a) * 0.28]} rotation={[Math.cos(a) * 0.22, 0, -Math.sin(a) * 0.22]}><cylinderGeometry args={[0.025, 0.02, 1.35, 6]} /><Mat c="#14151a" /></mesh>)}
    <group ref={head} position={[0, 1.45, 0]}>
      <mesh castShadow><boxGeometry args={[0.42, 0.34, 0.8]} /><Mat c="#1b1d26" m={0.3} r={0.5} /></mesh>
      <mesh position={[0, 0, 0.55]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.13, 0.17, 0.4, 16]} /><Mat c="#07080c" m={0.4} r={0.3} /></mesh>
      <mesh position={[0, 0.22, -0.12]}><boxGeometry args={[0.3, 0.1, 0.4]} /><Mat c="#2a2d3a" /></mesh>
      <mesh ref={tally} position={[0.1, 0.19, 0.3]}><sphereGeometry args={[0.035, 8, 8]} /><meshBasicMaterial color="#ff2d2d" /></mesh>
    </group></group>);
}

function Audience({ cheer, compact }) {
  const rows = compact ? 3 : 5, PER = 14;
  const people = useMemo(() => {
    const out = []; let k = 11; const rnd = () => { k = (k * 16807) % 2147483647; return k / 2147483647; };
    for (const side of [-1, 1]) for (let row = 0; row < rows; row++) for (let i = 0; i < PER; i++) {
      const x = side * (9.7 + row * 1.2), z = -6.5 + i * 1.2, top = row * 0.55 + 0.05;
      out.push({ x, y: top + 0.25, z, side, occ: rnd() > 0.16, sc: 0.92 + rnd() * 0.16, ph: rnd() * 6.28, sp: 1.1 + rnd() * 1.6, shirt: rnd(), skin: Math.floor(rnd() * 5), hair: Math.floor(rnd() * 5), yaw: Math.atan2(-x, -2 - z) });
    }
    return out;
  }, [rows]);
  const occ = useMemo(() => people.filter((p) => p.occ), [people]);
  const refs = { seat: useRef(), back: useRef(), torso: useRef(), head: useRef(), hair: useRef(), armL: useRef(), armR: useRef() };
  const T = useMemo(() => ({ g: new THREE.Matrix4(), l: new THREE.Matrix4(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), fw: new THREE.Vector3(0, 0, 1), col: new THREE.Color() }), []);
  const frame = useRef(0);
  const place = (mesh, i, base, yaw, sc, lx, ly, lz, rz) => {
    T.q.setFromAxisAngle(T.up, yaw); T.p.set(base.x, base.y, base.z); T.s.set(sc, sc, sc); T.g.compose(T.p, T.q, T.s);
    T.q2.setFromAxisAngle(T.fw, rz); T.p.set(lx, ly, lz); T.s.set(1, 1, 1); T.l.compose(T.p, T.q2, T.s); T.g.multiply(T.l); mesh.setMatrixAt(i, T.g);
  };
  useEffect(() => {   // static parts + colours (once)
    people.forEach((p, i) => { place(refs.seat.current, i, p, p.yaw, 1, 0, 0, 0, 0); place(refs.back.current, i, p, p.yaw, 1, 0, 0.42, -0.3, 0); });
    const SHIRTS = ['#1e3a8a', '#7f1d1d', '#facc15', '#0e7490', '#4338ca', '#be123c', '#ea580c', '#15803d', '#e5e7eb', '#6d28d9'], SKINS_A = ['#e8b895', '#d6a07a', '#b9825c', '#8d5a3b', '#a06b47'], HAIRS_A = ['#111', '#1a1412', '#2b1d14', '#3a2a1c', '#6b6b6b'];
    occ.forEach((p, i) => {
      T.col.set(SHIRTS[Math.floor(p.shirt * SHIRTS.length)]); refs.torso.current.setColorAt(i, T.col); T.col.set(SKINS_A[p.skin]); refs.head.current.setColorAt(i, T.col); refs.armL.current.setColorAt(i, T.col); refs.armR.current.setColorAt(i, T.col);
      T.col.set(HAIRS_A[p.hair]); refs.hair.current.setColorAt(i, T.col);
    });
    ['seat', 'back'].forEach((k) => { refs[k].current.instanceMatrix.needsUpdate = true; });
    ['torso', 'head', 'hair', 'armL', 'armR'].forEach((k) => { refs[k].current.instanceColor.needsUpdate = true; });
  }, [people, occ]); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame((st, dt) => {
    cheer.current = Math.max(0, cheer.current - Math.min(dt, 0.05) * 0.3);
    frame.current++; const c = cheer.current; if (c < 0.01 && frame.current % 3) return;
    const t = st.clock.elapsedTime;
    occ.forEach((p, i) => {
      const bob = Math.sin(t * p.sp + p.ph) * 0.012 + c * Math.abs(Math.sin(t * 5.5 + p.ph)) * 0.12, lift = c * Math.abs(Math.sin(t * 5.5 + p.ph)) * 0.12;
      place(refs.torso.current, i, p, p.yaw, p.sc, 0, 0.62 + bob, 0, 0);
      place(refs.head.current, i, p, p.yaw, p.sc, 0, 1.12 + bob, 0, 0);
      place(refs.hair.current, i, p, p.yaw, p.sc, 0, 1.17 + bob, -0.01, 0);
      const th = 0.14 + c * (2.5 + Math.sin(t * 8 + p.ph) * 0.3) + Math.sin(t * p.sp + p.ph) * 0.03;
      place(refs.armR.current, i, p, p.yaw, p.sc, 0.2 + Math.sin(th) * 0.19, 0.84 + bob - Math.cos(th) * 0.19, 0.02, th);
      place(refs.armL.current, i, p, p.yaw, p.sc, -0.2 - Math.sin(th) * 0.19, 0.84 + bob - Math.cos(th) * 0.19, 0.02, -th);
    });
    ['torso', 'head', 'hair', 'armL', 'armR'].forEach((k) => { refs[k].current.instanceMatrix.needsUpdate = true; });
  });
  const inst = (key, n, geo, mat) => <instancedMesh key={key} ref={refs[key]} args={[null, null, n]} frustumCulled={false} castShadow={key === 'torso'}>{geo}{mat}</instancedMesh>;
  return (<>
    {inst('seat', people.length, <boxGeometry args={[0.6, 0.5, 0.62]} />, <meshStandardMaterial color="#1a1d33" roughness={0.7} />)}
    {inst('back', people.length, <boxGeometry args={[0.58, 0.62, 0.08]} />, <meshStandardMaterial color="#232744" roughness={0.7} />)}
    {inst('torso', occ.length, <capsuleGeometry args={[0.17, 0.3, 6, 12]} />, <meshStandardMaterial roughness={0.85} />)}
    {inst('head', occ.length, <sphereGeometry args={[0.115, 14, 12]} />, <meshStandardMaterial roughness={0.6} />)}
    {inst('hair', occ.length, <sphereGeometry args={[0.122, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5]} />, <meshStandardMaterial roughness={0.9} />)}
    {inst('armL', occ.length, <capsuleGeometry args={[0.04, 0.26, 4, 8]} />, <meshStandardMaterial roughness={0.7} />)}
    {inst('armR', occ.length, <capsuleGeometry args={[0.04, 0.26, 4, 8]} />, <meshStandardMaterial roughness={0.7} />)}
    {[-1, 1].map((sd) => Array.from({ length: rows }, (_, row) => { const top = row * 0.55 + 0.05; return <mesh key={sd + '-' + row} position={[sd * (9.7 + row * 1.2), top / 2, 1.9]} receiveShadow><boxGeometry args={[1.2, top, 18]} /><meshStandardMaterial color={row % 2 ? '#0f1330' : '#12173a'} roughness={0.9} /></mesh>; }))}
  </>);
}

function Hall({ screen, compact, fresh }) {
  const [img, setImg] = useState(null);   // player photo for the LED screen (loaded with CORS so it can be drawn into the texture)
  const photo = screen && screen.photo;
  useEffect(() => {
    setImg(null);
    if (!photo) return undefined;
    let dead = false; const im = new Image(); im.crossOrigin = 'anonymous'; im.referrerPolicy = 'no-referrer';
    im.onload = () => { if (!dead) setImg(im); }; im.src = photo;
    return () => { dead = true; };
  }, [photo]);
  const LW = compact ? 6.4 : 11, LH = compact ? 5.12 : 5.5, LY = compact ? 3.7 : 3.95;
  const led = useTex((g, w, h) => drawLED(g, w, h, screen, compact, img), compact ? 800 : 1280, compact ? 640 : 640, [JSON.stringify(screen || null), compact, img]);
  const deskTex = useTex((g, w, h) => { g.fillStyle = '#2a1a0c'; g.fillRect(0, 0, w, h); g.fillStyle = '#ff8a1f'; g.fillRect(0, 0, w, 12); g.fillStyle = '#ffd36b'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `bold 78px ${IMPACT}`; g.fillText('IPL 2026', w / 2, h * 0.42); g.fillStyle = '#fff'; g.font = `bold 40px ${IMPACT}`; g.fillText('MEGA AUCTION', w / 2, h * 0.76); }, 512, 256, []);
  const floorTex = useTex((g, w, h) => { g.fillStyle = '#0a1030'; g.fillRect(0, 0, w, h); g.strokeStyle = 'rgba(122,162,255,.10)'; g.lineWidth = 2; for (let i = 0; i <= w; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); } }, 512, 512, []);
  useEffect(() => { floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping; floorTex.repeat.set(14, 14); floorTex.needsUpdate = true; }, [floorTex]);
  const wallTex = useTex((g, w, h) => { const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#0b1240'); gr.addColorStop(1, '#050a24'); g.fillStyle = gr; g.fillRect(0, 0, w, h); g.fillStyle = 'rgba(255,138,31,.10)'; for (let x = -h; x < w; x += 140) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 70, h); g.lineTo(x + 70 + h, 0); g.lineTo(x + h, 0); g.closePath(); g.fill(); } g.fillStyle = 'rgba(110,150,255,.12)'; for (let x = 40; x < w; x += 140) g.fillRect(x, 0, 6, h); }, 1024, 512, []);
  const bannerTex = useTex((g, w, h) => { g.fillStyle = '#070d33'; g.fillRect(0, 0, w, h); g.fillStyle = '#ff8a1f'; g.fillRect(0, 0, w, 14); g.fillRect(0, h - 14, w, 14); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#ffd36b'; g.font = `bold 120px ${IMPACT}`; g.fillText('IPL 2026', w / 2, h * 0.42); g.fillStyle = '#fff'; g.font = `bold 64px ${IMPACT}`; g.fillText('MEGA AUCTION  ·  FRIENDS EDITION', w / 2, h * 0.76); }, 1024, 256, []);
  const ceilTex = useTex((g, w, h) => { g.fillStyle = '#04071c'; g.fillRect(0, 0, w, h); g.fillStyle = '#cfe0ff'; for (let x = 32; x < w; x += 128) for (let y = 32; y < h; y += 128) g.fillRect(x, y, 64, 64); }, 512, 512, []);
  useEffect(() => { ceilTex.wrapS = ceilTex.wrapT = THREE.RepeatWrapping; ceilTex.repeat.set(5, 5); ceilTex.needsUpdate = true; }, [ceilTex]);
  const AY = STAGE_Y, SK = 1.25;   // auctioneer + podium are drawn 25% larger so the stage reads from the wide shot
  return (<>
    <color attach="background" args={['#050a22']} />
    <fog attach="fog" args={['#050a22', 34, 80]} />
    {/* floor + carpet */}
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={[80, 80]} /><meshStandardMaterial map={floorTex} roughness={0.28} metalness={0.45} /></mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0.8]} receiveShadow><planeGeometry args={[18.6, 24]} /><meshStandardMaterial color="#c9a24a" roughness={0.6} /></mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.008, 0.8]} receiveShadow><planeGeometry args={[18.2, 23.6]} /><meshStandardMaterial color="#0e1a44" roughness={0.95} /></mesh>
    {[-1, 1].map((sd) => <mesh key={sd} rotation={[-Math.PI / 2, 0, 0]} position={[sd * 0.9, 0.011, 2]}><planeGeometry args={[0.06, 20]} /><meshBasicMaterial color="#ff8a1f" /></mesh>)}
    {/* walls with branding */}
    <mesh position={[0, 6, -12.2]}><planeGeometry args={[46, 16]} /><meshBasicMaterial map={wallTex} toneMapped={false} /></mesh>
    {[-1, 1].map((sd) => <group key={sd}>
      <mesh position={[sd * 17, 6, 0]} rotation={[0, -sd * Math.PI / 2, 0]}><planeGeometry args={[34, 16]} /><meshBasicMaterial map={wallTex} toneMapped={false} /></mesh>
      <mesh position={[sd * 16.9, 5.4, 1]} rotation={[0, -sd * Math.PI / 2, 0]}><planeGeometry args={[12, 3]} /><meshBasicMaterial map={bannerTex} toneMapped={false} /></mesh>
      {[-8, -3, 2, 7].map((z) => <mesh key={z} position={[sd * 16.85, 2.6, z]}><boxGeometry args={[0.1, 5, 0.18]} /><meshBasicMaterial color="#ff8a1f" /></mesh>)}</group>)}
    {!compact && <mesh position={[0, 11.2, -1]} rotation={[Math.PI / 2, 0, 0]}><planeGeometry args={[46, 40]} /><meshBasicMaterial map={ceilTex} toneMapped={false} /></mesh>}
    {/* stage: wide platform with steps and a glowing edge */}
    <mesh position={[0, AY / 2, AUC.z - 0.7]} castShadow receiveShadow><boxGeometry args={[14, AY, 5.4]} /><meshStandardMaterial color="#141a3d" roughness={0.35} metalness={0.3} /></mesh>
    <mesh position={[0, AY / 2 - 0.1, AUC.z + 2.35]} receiveShadow><boxGeometry args={[7, AY - 0.2, 0.7]} /><meshStandardMaterial color="#10163a" roughness={0.5} /></mesh>
    <mesh position={[0, AY + 0.004, AUC.z + 2.02]}><boxGeometry args={[14, 0.04, 0.07]} /><meshBasicMaterial color="#ffb347" /></mesh>
    <mesh position={[0, 0.02, AUC.z + 2.03]}><boxGeometry args={[14, 0.04, 0.05]} /><meshBasicMaterial color="#ff8a1f" /></mesh>
    {/* giant LED screen behind the auctioneer (nothing hangs in front of it) */}
    <mesh position={[0, LY, AUC.z - 2.55]}><boxGeometry args={[LW + 0.5, LH + 0.4, 0.2]} /><meshStandardMaterial color="#05060d" roughness={0.5} /></mesh>
    <mesh position={[0, LY, AUC.z - 2.44]}><planeGeometry args={[LW, LH]} /><meshBasicMaterial map={led} toneMapped={false} /></mesh>
    <mesh position={[0, LY + LH / 2 + 0.28, AUC.z - 2.4]}><boxGeometry args={[LW + 0.5, 0.06, 0.06]} /><meshBasicMaterial color="#ff8a1f" /></mesh>
    <Wipe k={screen && screen.name} LW={LW} LH={LH} />
    {fresh && <ResultCard key={fresh.key} r={fresh} LW={LW} />}
    {[-1, 1].map((sd) => sd * (LW / 2 + 1.1)).map((x) => <mesh key={x} position={[x, 3, AUC.z - 2.35]}><boxGeometry args={[0.7, 6, 0.5]} /><meshStandardMaterial color="#0e1230" roughness={0.6} /></mesh>)}
    {[-1, 1].map((sd) => sd * (LW / 2 + 1.1)).map((x) => <mesh key={'g' + x} position={[x, 3, AUC.z - 2.08]}><boxGeometry args={[0.1, 5.6, 0.04]} /><meshBasicMaterial color="#ff8a1f" /></mesh>)}
    {/* podium, microphone, gavel block */}
    <mesh position={[AUC.x, AY + 0.55, AUC.z + 0.94]} castShadow><boxGeometry args={[2.4, 1.1, 0.78]} /><meshStandardMaterial color="#2a1a0c" roughness={0.35} /></mesh>
    <mesh position={[AUC.x, AY + 1.12, AUC.z + 0.94]}><boxGeometry args={[2.5, 0.06, 0.86]} /><meshStandardMaterial color="#ffb347" roughness={0.3} metalness={0.4} /></mesh>
    <mesh position={[AUC.x, AY + 0.55, AUC.z + 1.335]}><planeGeometry args={[2.2, 0.9]} /><meshBasicMaterial map={deskTex} toneMapped={false} /></mesh>
    <mesh position={[AUC.x + 0.38, AY + 1.17, AUC.z + 0.62]}><cylinderGeometry args={[0.16, 0.19, 0.06, 20]} /><meshStandardMaterial color="#5a3a1e" roughness={0.4} /></mesh>
    <group position={[AUC.x - 0.45, AY + 1.15, AUC.z + 1.05]}>
      <mesh position={[0, 0.2, 0]}><cylinderGeometry args={[0.014, 0.014, 0.4, 8]} /><meshStandardMaterial color="#aaa" metalness={0.8} roughness={0.3} /></mesh>
      <mesh position={[0, 0.42, -0.06]} rotation={[0.9, 0, 0]}><cylinderGeometry args={[0.012, 0.012, 0.2, 8]} /><meshStandardMaterial color="#aaa" metalness={0.8} roughness={0.3} /></mesh>
      <mesh position={[0, 0.5, -0.14]}><sphereGeometry args={[0.05, 12, 10]} /><meshStandardMaterial color="#111" roughness={0.5} /></mesh></group>
  </>);
}

function Table({ team, leading }) {
  const ab = abbr(team.name);
  const front = useTex((g, w, h) => { g.fillStyle = team.color; g.fillRect(0, 0, w, h); g.fillStyle = 'rgba(0,0,0,.30)'; g.fillRect(0, h * 0.7, w, h * 0.3); g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `bold 120px ${IMPACT}`; g.fillText(ab, w * 0.3, h * 0.42); g.font = `bold 46px Arial, sans-serif`; g.fillText(String(team.name).toUpperCase().slice(0, 26), w * 0.64, h * 0.3); g.font = `bold 34px Arial, sans-serif`; g.fillText(`PADDLE  #${pad(team.no)}`, w * 0.64, h * 0.56); g.font = '30px Arial, sans-serif'; g.fillText(team.owner || '', w / 2, h * 0.86); }, 1024, 256, [team.color, team.name, team.no, team.owner]);
  const plate = useTex((g, w, h) => { g.fillStyle = '#f4f1e8'; g.fillRect(0, 0, w, h); g.fillStyle = team.color; g.fillRect(0, 0, w, 18); g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = 'bold 56px Arial, sans-serif'; g.fillText(String(team.owner || team.name).toUpperCase().slice(0, 16), w / 2, h * 0.5); g.font = '32px Arial, sans-serif'; g.fillStyle = '#555'; g.fillText(String(team.name).slice(0, 24), w / 2, h * 0.82); }, 512, 160, [team.color, team.name, team.owner]);
  const scr = useRef();
  useFrame((_, dt) => { if (scr.current) scr.current.emissiveIntensity = damp(scr.current.emissiveIntensity, leading ? 1.8 : 0.35, 6, Math.min(dt, 0.05)); });
  return (<group position={[0, 0, TABLE_FWD]}>
    <mesh position={[0, TABLE_Y, 0]} castShadow receiveShadow><boxGeometry args={[2.5, 0.07, 0.95]} /><meshStandardMaterial color="#4a2a14" roughness={0.28} metalness={0.15} /></mesh>
    <mesh position={[0, TABLE_Y + 0.036, 0.47]}><boxGeometry args={[2.52, 0.012, 0.03]} /><meshBasicMaterial color={team.color} /></mesh>
    <mesh position={[0, TABLE_Y - 0.33, 0.44]} castShadow><boxGeometry args={[2.5, 0.62, 0.03]} /><meshStandardMaterial color="#1a1209" roughness={0.6} /></mesh>
    <mesh position={[0, TABLE_Y - 0.32, 0.458]}><planeGeometry args={[2.4, 0.6]} /><meshBasicMaterial map={front} toneMapped={false} /></mesh>
    {[-1.18, 1.18].map((x) => <mesh key={x} position={[x, TABLE_Y / 2 - 0.02, 0]} castShadow><boxGeometry args={[0.06, TABLE_Y - 0.06, 0.9]} /><meshStandardMaterial color="#1a1209" roughness={0.6} /></mesh>)}
    <mesh position={[0, TABLE_Y + 0.2, -0.1]} rotation={[-0.3, Math.PI, 0]}><boxGeometry args={[0.5, 0.31, 0.025]} /><meshStandardMaterial ref={scr} color="#0a0d18" emissive={team.color} emissiveIntensity={0.35} roughness={0.3} /></mesh>
    <mesh position={[0, TABLE_Y + 0.045, -0.04]}><boxGeometry args={[0.5, 0.02, 0.34]} /><meshStandardMaterial color="#9aa0aa" metalness={0.6} roughness={0.35} /></mesh>
    <mesh position={[0.85, TABLE_Y + 0.19, 0.15]} rotation={[0, 0.3, 0]}><planeGeometry args={[0.46, 0.14]} /><meshBasicMaterial map={plate} side={THREE.DoubleSide} toneMapped={false} /></mesh>
    <mesh position={[0.85, TABLE_Y + 0.07, 0.15]} rotation={[0, 0.3, 0]}><boxGeometry args={[0.46, 0.08, 0.02]} /><meshStandardMaterial color="#d9d9d9" roughness={0.3} metalness={0.4} /></mesh>
    <mesh position={[-0.8, TABLE_Y + 0.15, 0.2]}><cylinderGeometry args={[0.04, 0.04, 0.24, 12]} /><meshStandardMaterial color="#8fd3ff" transparent opacity={0.7} roughness={0.1} /></mesh>
    <mesh position={[-0.65, TABLE_Y + 0.08, 0.2]}><cylinderGeometry args={[0.035, 0.03, 0.09, 12]} /><meshStandardMaterial color="#dff3ff" transparent opacity={0.6} roughness={0.1} /></mesh>
  </group>);
}

const SHOT_FOV = { wide: 36, table: 30, celebrate: 36, auc: 31, screen: 32 };
const DUR = { wide: 1.8, table: 1.1, celebrate: 1.3, auc: 1.4, screen: 1.5 };   // seconds each camera move takes
const PUSH = { screen: 0.15, table: 0.08, celebrate: 0.1, auc: 0.06 };         // how far each shot slowly pushes in
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function Scene({ teams, curBidder, curBid, fresh, saleKey, screen, labelRefs, camMode, cheer, call, lotKey, onShot }) {
  const { camera, size } = useThree();
  const n = teams.length, compact = size.width / Math.max(size.height, 1) < 1.3, slots = useMemo(() => slotsFor(n, compact ? 0.7 : 1), [n, compact]);
  const idx = teams.findIndex((t) => t.id === curBidder);
  const light = useRef(), v = useMemo(() => new THREE.Vector3(), []), col = useMemo(() => new THREE.Color(), []);
  const wide = useRef({ pos: new THREE.Vector3(0, 9, 16), target: new THREE.Vector3(0, 1.4, -2) }).current;
  const cam = useRef({ look: new THREE.Vector3(0, 1.4, -2), init: false, id: '', t0: 0, dur: 1.2, from: { p: new THREE.Vector3(), l: new THREE.Vector3(), fov: 36 } }).current;
  const T = useMemo(() => ({ p: new THREE.Vector3(), l: new THREE.Vector3(), d: new THREE.Vector3() }), []);
  const teamsRef = useRef(teams); teamsRef.current = teams;
  const focus = useRef({ x: AUC.x, z: AUC.z }); focus.current = idx >= 0 && slots[idx] ? { x: slots[idx].x, z: slots[idx].z } : { x: AUC.x, z: AUC.z + 4 };
  const LW = compact ? 6.4 : 11;

  useEffect(() => {   // wide shot: fit AND centre the stage, LED screen and every table at any card size / team count
    const t = new THREE.Vector3(0, 1.6, -2), dir = new THREE.Vector3(2.5, 5.2, 12).normalize(), hw = compact ? 0.62 : 1;
    const pts = [new THREE.Vector3(-7 * hw, 0, AUC.z), new THREE.Vector3(7 * hw, 0, AUC.z), new THREE.Vector3(-LW / 2 - 0.8, 6.8, AUC.z - 2.4), new THREE.Vector3(LW / 2 + 0.8, 6.8, AUC.z - 2.4)];
    slots.forEach((s) => { pts.push(new THREE.Vector3(s.tx - 1.3, 0, s.tz + 0.6), new THREE.Vector3(s.tx + 1.3, 0, s.tz + 0.6), new THREE.Vector3(s.x, 2.4, s.z), new THREE.Vector3(s.x - 0.6, 0, s.z + 0.9), new THREE.Vector3(s.x + 0.6, 0, s.z + 0.9)); });   // incl. the chair behind each rep so the nearest table is never cut off
    const c = camera.clone(); c.fov = SHOT_FOV.wide; c.aspect = size.width / Math.max(size.height, 1); const th = Math.tan(THREE.MathUtils.degToRad(c.fov / 2)); let d = 20;
    const right = new THREE.Vector3(), up = new THREE.Vector3(), tmp = new THREE.Vector3();
    for (let k = 0; k < 16; k++) {
      c.position.copy(t).addScaledVector(dir, d); c.lookAt(t); c.updateMatrixWorld(); c.updateProjectionMatrix();
      let x0 = 9, x1 = -9, y0 = 9, y1 = -9; for (const p of pts) { const q = tmp.copy(p).project(c); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
      const w = Math.max((x1 - x0) / 2, (y1 - y0) / 2, 0.05), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      right.setFromMatrixColumn(c.matrixWorld, 0); up.setFromMatrixColumn(c.matrixWorld, 1);
      t.addScaledVector(right, cx * d * th * c.aspect * 0.8).addScaledVector(up, cy * d * th * 0.8);
      d *= Math.pow(w / 0.96, 0.9);   // 0.96: the arena fills almost the whole frame
    }
    wide.pos.copy(t).addScaledVector(dir, d); wide.target.copy(t);
    if (!cam.fitted) { cam.fitted = true; cam.init = false; }
  }, [camera, size.width, size.height, slots, compact, LW]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- BROADCAST DIRECTOR ------------------------------------------------------------------------------------------
  // Every cut in Auto is requested by a REAL room event: a server-accepted bid, a new lot, a going-once/twice/final call, or a sale the
  // server has confirmed. Rules: each shot is held a minimum time; a more important event may cut in only after a short dwell; anything
  // else waits in a one-slot queue and is dropped if it goes stale; repeated Realtime/poll echoes of the same state never cut again.
  // Manual modes (Wide / Auctioneer / Bidder / Player) switch the director off until Auto is selected again.
  const MIN_DWELL = 1.4, PR = { wide: 0, auc: 1, screen: 2, table: 3, celebrate: 4 };
  const camModeRef = useRef(camMode); camModeRef.current = camMode;
  const dir = useRef({ cur: { kind: 'wide', tid: null, since: 0, until: Infinity, pr: 0 }, pend: null, lot: lotKey, bid: { lot: lotKey, amt: curBid || 0, who: curBidder } }).current;   // starts from the state at page load: no cut for history
  const nowS = () => performance.now() / 1000;
  const startShot = (r, now) => { dir.cur = { kind: r.kind, tid: r.tid, since: now, until: now + r.hold, pr: r.pr }; if (dir.pend && dir.pend.pr <= r.pr) dir.pend = null; };
  const request = (kind, tid, hold, ttl) => {
    if (camModeRef.current !== 'auto') return;
    const now = nowS(), c = dir.cur, pr = PR[kind], r = { kind, tid, hold, pr, ttl: now + ttl };
    if (c.kind === 'wide') { startShot(r, now); return; }
    if (c.kind === kind && c.tid === tid) { c.until = Math.max(c.until, now + hold); return; }   // same shot: extend it, no new cut
    if ((pr > c.pr || now >= c.until) && now - c.since >= (pr >= 4 ? 0.6 : MIN_DWELL)) startShot(r, now);
    else if (!dir.pend || pr >= dir.pend.pr) dir.pend = r;
  };
  const tick = (now) => {
    const c = dir.cur, p = dir.pend;
    if (c.kind !== 'wide' && now >= c.until) { if (p && p.ttl > now) startShot(p, now); else { dir.pend = null; dir.cur = { kind: 'wide', tid: null, since: now, until: Infinity, pr: 0 }; } }
    else if (p && p.pr > c.pr && now - c.since >= (p.pr >= 4 ? 0.6 : MIN_DWELL)) { if (p.ttl > now) startShot(p, now); else dir.pend = null; }
  };
  useEffect(() => { dir.cur = { kind: 'wide', tid: null, since: nowS(), until: Infinity, pr: 0 }; dir.pend = null; }, [camMode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {   // a new player on the block (server state), once per lot
    if (!lotKey || dir.lot === lotKey) return;
    dir.lot = lotKey; dir.bid = { lot: lotKey, amt: 0, who: null };
    request('screen', null, 2.9, 3.2);
  }, [lotKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {   // a valid, server-accepted bid: a new highest amount in the current lot from a seated franchise
    if (!lotKey || !curBidder || !teams.some((t) => t.id === curBidder)) return;
    const b = dir.bid;
    if (b.lot === lotKey && b.who === curBidder && curBid <= b.amt) return;   // repeated Realtime / poll echo
    if (b.lot === lotKey && curBid < b.amt) return;                            // a lower amount is an undo, not a new bid
    dir.bid = { lot: lotKey, amt: curBid, who: curBidder };
    cheer.current = Math.max(cheer.current, 0.1);
    request('table', curBidder, 2.4, 3);
  }, [lotKey, curBidder, curBid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (call && call !== 'Any bids?') request('auc', null, 2.2, 1.5); }, [call]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {   // sale confirmed by the backend
    if (!fresh) return;
    if (fresh.status === 'sold' && teams.some((t) => t.id === fresh.fid)) { request('celebrate', fresh.fid, 3.4, 6); cheer.current = 1; } else { request('auc', null, 2.6, 6); cheer.current = Math.max(cheer.current, 0.25); }
  }, [fresh]); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((_, dt0) => {
    const dt = Math.min(dt0, 0.05), now = nowS();
    if (camMode === 'auto') tick(now);
    let sh;
    if (camMode === 'auto') sh = dir.cur;
    else if (camMode === 'auc') sh = { kind: 'auc' };
    else if (camMode === 'player') sh = { kind: 'screen' };
    else if (camMode === 'bidder') { const tid = curBidder || (fresh && fresh.status === 'sold' ? fresh.fid : null); sh = tid ? { kind: 'table', tid } : { kind: 'wide' }; }   // no bidder yet: back to wide
    else sh = { kind: 'wide' };
    const withTeam = sh.kind === 'table' || sh.kind === 'celebrate';
    const ti = withTeam ? teamsRef.current.findIndex((t) => t.id === sh.tid) : -1, s = ti >= 0 ? slots[ti] : null;
    const kind = withTeam && !s ? 'wide' : sh.kind, id = kind + ':' + (s ? sh.tid : '');
    let fov = SHOT_FOV[kind];
    if (kind === 'table') { const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw), d = compact ? 3.1 : 3.9; T.p.set(s.x + fx * d + fz * 1.0, 2.05, s.z + fz * d - fx * 1.0); T.l.set(s.x + fx * 0.35, 1.3, s.z + fz * 0.35); }
    else if (kind === 'celebrate') { const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw); T.p.set(s.x + fx * 5.2 + fz * 1.8, 2.7, s.z + fz * 5.2 - fx * 1.8); T.l.set(s.x + fx * 1.2, 1.45, s.z + fz * 1.2); }
    else if (kind === 'auc') { T.p.set(AUC.x + 1.5, STAGE_Y + 2.2, AUC.z + (compact ? 6.4 : 5.6)); T.l.set(AUC.x - 0.2, STAGE_Y + 2.0, AUC.z - 0.4); }
    else if (kind === 'screen') { T.p.set(0, 4.4, AUC.z - 2.44 + LW * 1.3); T.l.set(0, 3.95, AUC.z - 2.44); }
    else { T.p.copy(wide.pos); T.l.copy(wide.target); }
    if (id !== cam.id) {   // a cut: remember where the camera is NOW and ease from there
      cam.from.p.copy(camera.position); cam.from.l.copy(cam.look); cam.from.fov = camera.fov; cam.t0 = now; cam.id = id; cam.dur = DUR[kind];
      if (!cam.init) { cam.from.p.copy(T.p); cam.from.l.copy(T.l); cam.from.fov = fov; cam.t0 = now - 10; cam.init = true; }
      if (onShot) onShot({ kind, tid: s ? sh.tid : null });
    }
    if (!cam.init) { cam.init = true; cam.from.p.copy(T.p); cam.from.l.copy(T.l); cam.from.fov = fov; cam.t0 = now - 10; }
    const push = ease(clamp((now - cam.t0) / 4, 0, 1)), pf = PUSH[kind];   // slow push-in (zoom) while a shot is held
    if (pf) { T.d.copy(T.p).sub(T.l); T.p.copy(T.l).addScaledVector(T.d, 1 + pf * (1 - push)); }
    if (kind === 'screen') fov += (1 - push) * 4;
    const e = ease(clamp((now - cam.t0) / cam.dur, 0, 1));
    camera.position.lerpVectors(cam.from.p, T.p, e); cam.look.lerpVectors(cam.from.l, T.l, e); camera.fov = lerp(cam.from.fov, fov, e);
    camera.updateProjectionMatrix(); camera.lookAt(cam.look); camera.updateMatrixWorld();
    teams.forEach((t, i) => {   // pin the HTML name tags to the 3D tables
      const el = labelRefs.current[t.id]; if (!el) return;
      v.set(slots[i].tx, 1.1, slots[i].tz + 0.5).project(camera);
      const onScreen = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      el.style.transform = `translate(${((v.x * 0.5 + 0.5) * size.width).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * size.height).toFixed(1)}px) translate(-50%, -100%)`; el.style.opacity = onScreen ? '1' : '0';
    });
    const L = light.current; if (!L) return;   // coloured spotlight on whoever leads
    const sl = idx >= 0 ? slots[idx] : null;
    if (sl) { L.position.x = damp(L.position.x, sl.x, 6, dt); L.position.z = damp(L.position.z, sl.z, 6, dt); col.set(teams[idx].color); L.color.lerp(col, 1 - Math.exp(-6 * dt)); }
    L.intensity = damp(L.intensity, sl ? 26 : 0, 5, dt);
  });

  return (<>
    <ambientLight intensity={0.8} /><hemisphereLight args={['#b8c8ff', '#2a2350', 0.9]} />
    <directionalLight position={[4, 12, 8]} intensity={2.0} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-14} shadow-camera-right={14} shadow-camera-top={14} shadow-camera-bottom={-14} shadow-camera-far={44} shadow-bias={-0.0004} />
    <pointLight position={[0, 6.5, AUC.z + 2]} intensity={110} color="#ffc266" distance={16} decay={1.6} />
    <pointLight position={[-4, 5, AUC.z + 3]} intensity={40} color="#ff8a1f" distance={12} decay={1.8} /><pointLight position={[4, 5, AUC.z + 3]} intensity={40} color="#ff8a1f" distance={12} decay={1.8} />
    <pointLight position={[-7, 6, 0]} intensity={34} color="#7aa2ff" distance={18} decay={1.6} /><pointLight position={[7, 6, 0]} intensity={34} color="#7aa2ff" distance={18} decay={1.6} />
    <pointLight ref={light} position={[0, 3, 0]} intensity={0} distance={6.5} decay={1.5} />
    <Hall screen={screen} compact={compact} fresh={fresh} /><Audience cheer={cheer} compact={compact} />
    {!compact && <><TVCam x={-8} z={-4.6} focus={focus} /><TVCam x={8} z={-4.6} focus={focus} /></>}
    {teams.map((t, i) => <group key={t.id}>
      <group position={[slots[i].x, 0, slots[i].z]} rotation={[0, slots[i].yaw, 0]}><Table team={t} leading={t.id === curBidder} /></group>
      <Person pos={{ x: slots[i].x, z: slots[i].z }} yaw={slots[i].yaw} seated item="paddle" index={i} skin={SKINS[i % 5]} hair={HAIRS[(i * 3) % 5]} suit={new THREE.Color(t.color).multiplyScalar(0.4).getStyle()} tie={t.color} color={t.color} no={t.no} short={abbr(t.name)} target={t.id === curBidder} />
      {(compact ? [0.85] : [-0.85, 0.85]).map((lx, k) => <Person key={k} pos={{ x: slots[i].x + lx * Math.cos(slots[i].yaw), z: slots[i].z - lx * Math.sin(slots[i].yaw) }} yaw={slots[i].yaw} seated item="idle" shadow={false} index={20 + i * 3 + k} skin={SKINS[(i + k + 2) % 5]} hair={HAIRS[(i * 2 + k + 1) % 5]} suit={new THREE.Color(t.color).multiplyScalar(0.55).getStyle()} tie="#f2f2f2" color={t.color} no={t.no} short={abbr(t.name)} />)}
    </group>)}
    <Person pos={{ x: AUC.x, y: STAGE_Y, z: AUC.z }} yaw={0} scale={1.25} item="gavel" index={7} skin={SKINS[2]} hair={HAIRS[2]} suit="#25262e" tie="#ffb347" color="#ffb347" strikeKey={saleKey} lookAt={idx >= 0 ? { x: slots[idx].x, z: slots[idx].z } : null} />
  </>);
}

/**
 * teams: [{id, name, color, no, owner, purse, squad}] in room order.  curBidder / curBid: server-confirmed highest bidder + amount.
 * sale: latest server-confirmed result {key, status, fid, player, team, price, color} - a SOLD/UNSOLD card + celebration shot is
 * shown only when this changes AFTER the page loaded.   screen: LED data (see drawLED).   topbar / panel (lower third) / controls: HTML overlays.
 */
export default function BidderStage({ teams = [], curBidder = null, curBid = 0, sale = null, screen = null, call = null, lotKey = null, topbar = null, panel = null, controls = null, className = 'h-[500px] sm:h-[560px] lg:h-[calc(100vh-110px)] lg:min-h-[560px]' }) {
  const [ok, setOk] = useState(false), [camMode, setCamMode] = useState('auto'), [fresh, setFresh] = useState(null), [onAir, setOnAir] = useState({ kind: 'wide', tid: null });
  const labelRefs = useRef({}), cheer = useRef(0), seen = useRef(sale ? sale.key : null);
  useEffect(() => { try { const c = document.createElement('canvas'); setOk(!!(c.getContext('webgl2') || c.getContext('webgl'))); } catch (e) { setOk(false); } }, []);
  useEffect(() => {   // new server-confirmed result since the page opened (history on first load is ignored; safe under React StrictMode)
    if (!sale || !sale.key || sale.key === seen.current) return undefined;
    seen.current = sale.key; setFresh(sale);
    const tm = setTimeout(() => setFresh(null), 4600); return () => clearTimeout(tm);
  }, [sale && sale.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ok || !teams.length) return null;   // no WebGL: the normal auction screen still works
  const MODES = [['auto', '🎥', 'Auto'], ['wide', '🏟', 'Wide'], ['auc', '🎙', 'Auctioneer'], ['bidder', '🙋', 'Bidder'], ['player', '📺', 'Player']];
  const AIR = { wide: 'Wide', table: 'Bidder', celebrate: 'Sold', auc: 'Auctioneer', screen: 'Player' };
  const bt = onAir.kind === 'table' ? teams.find((t) => t.id === onAir.tid) : null;
  return (<div className="relative select-none overflow-hidden rounded-2xl border border-white/10 bg-[#050a22]" style={{ padding: 0 }}>
    <div className={className} style={{ touchAction: 'pan-y' }}>
      <Canvas shadows dpr={[1, 1.75]} camera={{ fov: 36, position: [0, 9, 16] }} gl={{ antialias: true }}>
        <Scene teams={teams} curBidder={curBidder} curBid={curBid} fresh={fresh} saleKey={sale ? sale.key : ''} screen={screen} labelRefs={labelRefs} camMode={camMode} cheer={cheer} call={call} lotKey={lotKey} onShot={setOnAir} />
      </Canvas>
    </div>
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {teams.map((t) => { const lead = t.id === curBidder; return (
        <div key={t.id} ref={(el) => { labelRefs.current[t.id] = el; }} className="absolute left-0 top-0" style={{ opacity: 0, willChange: 'transform' }}>
          <div className="flex flex-col items-center gap-0.5">
            {lead && <div key={curBid} className="pop rounded-full px-2.5 py-0.5 text-sm font-extrabold text-white shadow-lg sm:text-lg" style={{ background: t.color, boxShadow: `0 0 18px ${t.color}` }}>{cr(curBid)}</div>}
            <div className="flex items-center gap-1 rounded-lg border bg-black/75 px-1.5 py-0.5 text-[10px] backdrop-blur sm:gap-2 sm:px-2 sm:py-1 sm:text-xs" style={{ borderColor: lead ? t.color : 'rgba(255,255,255,.18)', boxShadow: lead ? `0 0 16px ${t.color}` : 'none' }}>
              <Logo team={t.name} size={24} />
              <div className="leading-tight"><div className="font-bold uppercase">{abbr(t.name)} <span className="rounded bg-white px-1 text-black">#{pad(t.no)}</span></div>
                {t.owner ? <div className="hidden max-w-[110px] truncate text-slate-300 sm:block">{t.owner}</div> : null}
                {t.purse != null ? <div className="hidden text-[10px] text-amber-300 sm:block">{cr(t.purse)} · {t.squad ?? 0} players</div> : null}</div>
            </div>
          </div>
        </div>); })}
    </div>
    {topbar && <div className="pointer-events-none absolute left-3 top-3 z-10">{topbar}</div>}
    <div className="absolute right-3 top-3 z-20 flex items-center gap-1.5">
      <span className="hidden items-center gap-1 rounded bg-black/65 px-1.5 py-1 text-[10px] font-bold uppercase tracking-widest text-slate-200 backdrop-blur md:inline-flex"><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />On air · {AIR[onAir.kind] || 'Wide'}</span>
      <div className="inline-flex gap-0.5 rounded-lg bg-black/65 p-0.5 backdrop-blur">{MODES.map(([k, ic, l]) => <button key={k} title={`${l} camera`} onClick={() => setCamMode(k)} className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-bold uppercase tracking-wide ${camMode === k ? 'bg-amber-400 text-black' : 'text-slate-200 hover:bg-white/10'}`}><span>{ic}</span><span className="hidden lg:inline">{l}</span></button>)}</div></div>
    {bt && <div key={bt.id + ':' + curBid} className="pop pointer-events-none absolute left-1/2 top-14 z-10 flex -translate-x-1/2 items-center gap-3 rounded-xl border-l-8 bg-[#071033]/95 px-4 py-2 shadow-2xl backdrop-blur" style={{ borderColor: bt.color }}>
      <Logo team={bt.name} size={40} />
      <div className="min-w-0"><div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Bidder cam · Paddle #{pad(bt.no)}</div><div className="max-w-[220px] truncate font-display text-xl font-extrabold uppercase leading-tight">{bt.name}</div>{bt.owner ? <div className="max-w-[220px] truncate text-xs text-slate-300">{bt.owner}</div> : null}</div>
      <div className="score text-3xl font-extrabold text-amber-400">{cr(curBid)}</div></div>}
    {panel && <div className="pointer-events-none absolute bottom-[84px] left-3 z-10 max-w-[calc(100%-1.5rem)] sm:bottom-3 sm:max-w-[58%]">{panel}</div>}
    {controls && <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 sm:left-auto sm:right-3 sm:translate-x-0">{controls}</div>}
  </div>);
}
