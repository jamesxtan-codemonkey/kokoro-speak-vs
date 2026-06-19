import { createRequire } from "node:module";
import { copyFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { StreamPlayer } = require("./playertest.cjs");
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const tmp = (k)=>{const f=`/tmp/segrun${k}-${Date.now()}.wav`; copyFileSync(`/tmp/seg${((k%3)+1)}.wav`,f); return f;};

// Test 1: seamless 3x1s — expect total ~3.86s (one startup), not ~5.6s
await new Promise(async (resolve)=>{
  const t0=Date.now(); let speak=0;
  const sp=new StreamPlayer({onSpeaking:()=>{speak=Date.now()-t0;}, onIdle:()=>{console.error(`T1 total=${((Date.now()-t0)/1000).toFixed(2)}s firstAudioSpawn=${(speak/1000).toFixed(2)}s (expect total~3.8, sequential would be ~5.6)`); resolve();}, onUnavailable:()=>{console.error("UNAVAIL");resolve();}});
  sp.add(tmp(1),1.0); await sleep(50); sp.add(tmp(2),1.0); await sleep(50); sp.add(tmp(3),1.0); sp.end();
});
// Test 2: stop mid-stream
await new Promise(async (resolve)=>{
  let idle=false; const sp=new StreamPlayer({onSpeaking:()=>{}, onIdle:()=>{idle=true;}, onUnavailable:()=>{}});
  sp.add(tmp(1),1.0); sp.add(tmp(2),1.0); sp.end();
  await sleep(400); sp.stop(); await sleep(300);
  console.error(`T2 after stop: isActive=${sp.isActive} (expect false)`);
  resolve();
});
// Test 3: pause/resume toggles
await new Promise(async (resolve)=>{
  const sp=new StreamPlayer({onSpeaking:()=>{}, onIdle:()=>{}, onUnavailable:()=>{}});
  sp.add(tmp(1),1.0); sp.add(tmp(2),1.0); sp.end();
  await sleep(300); const a=sp.togglePause(); await sleep(200); const b=sp.togglePause();
  console.error(`T3 pause->${a} resume->${b} (expect paused, speaking)`);
  await sleep(50); sp.stop(); resolve();
});
