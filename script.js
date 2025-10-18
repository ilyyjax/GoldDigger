/* script.js - GoldDigger
   All game logic: rendering, movement, mining, inventory, shop, save/load
   No external libraries, fully modular.
*/

/* --------------------------
   Helper Utilities
   -------------------------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

/* audio helper: small WebAudio synth for effects (no external files) */
class SFX {
  constructor() {
    this.ctx = null;
    this.gain = null;
  }
  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.12;
      this.gain.connect(this.ctx.destination);
    }
  }
  playTone(freq=440, time=0.08, type='sine', decay=0.1) {
    this.ensure();
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    o.connect(g); g.connect(this.gain);
    o.start();
    g.gain.setValueAtTime(1, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + time + decay);
    o.stop(this.ctx.currentTime + time + decay + 0.02);
  }
  click(){ this.playTone(880,0.04,'square')}
  mine(){ this.playTone(220,0.06,'sawtooth')}
  sell(){ this.playTone(1200,0.12,'triangle',0.12)}
  buy(){ this.playTone(900,0.1,'sine')}
}
const sfx = new SFX();

/* popup */
function popup(text, ttl=1600){
  const p = document.createElement('div');
  p.className = 'popup';
  p.textContent = text;
  $('#popups').appendChild(p);
  setTimeout(()=> p.remove(), ttl);
}

/* --------------------------
   Game constants & data
   -------------------------- */
const TILE_SIZE = 16;  // pixels for each tile (visual scale)
const VIEW_W = 30;     // tiles wide canvas grid
const VIEW_H = 40;     // tiles tall (visible)
const WORLD_W = VIEW_W;
const WORLD_H = 500;   // vertical depth tiles (0 = surface at top)
const SURFACE_ROW = 4; // top few rows are surface dirt

// ore definitions
const ORE_TYPES = [
  { id:'dirt', name:'Dirt', color:'#8b6b3a', hardness:1, value:1, rarity:1 },
  { id:'stone', name:'Stone', color:'#666666', hardness:2, value:0, rarity:0.9 },
  { id:'coal', name:'Coal', color:'#101010', hardness:2, value:5, rarity:0.6 },
  { id:'iron', name:'Iron', color:'#c0c0c0', hardness:3, value:10, rarity:0.35 },
  { id:'gold', name:'Gold', color:'#ffd54a', hardness:4, value:25, rarity:0.18 },
  { id:'diamond', name:'Diamond', color:'#80e0ff', hardness:6, value:50, rarity:0.06 }
];

// Upgrades catalog
const UPGRADES = [
  { id:'pick1', name:'Pickaxe +1', desc:'Decrease hits required by 1 (min 1)', cost:100, apply: (state)=>{ state.pickLevel += 1 } },
  { id:'pack1', name:'Backpack +20', desc:'Increase inventory capacity', cost:120, apply: (state)=>{ state.invCapacity += 20 } },
  { id:'fuel1', name:'Fuel Tank +20', desc:'Increase energy capacity', cost:80, apply: (state)=>{ state.maxEnergy += 20; state.energy += 20 } }
];

/* --------------------------
   Game state (persisted)
   -------------------------- */
let state = {
  money: 0,
  inventory: {},   // {oreId: count}
  invCapacity: 50,
  pickLevel: 1,
  maxEnergy: 100,
  energy: 100,
  upgradesOwned: {},
  player: { x: Math.floor(WORLD_W/2), y: 2 }, // start near surface
  depthOffset: 0 // camera offset
};

/* Save / Load */
const SAVE_KEY = 'golddigger_save_v1';
function saveState(){
  localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  popup('Game saved');
}
function loadState(){
  const s = localStorage.getItem(SAVE_KEY);
  if(s){
    try{
      const parsed = JSON.parse(s);
      state = Object.assign(state, parsed);
      // safety: ensure values exist
      state.player = state.player || {x: Math.floor(WORLD_W/2), y: 2};
      state.inventory = state.inventory || {};
      popup('Save loaded');
      return true;
    }catch(e){ console.warn('load failed', e) }
  }
  return false;
}
function resetSave(){
  localStorage.removeItem(SAVE_KEY);
  location.reload();
}

/* --------------------------
   World generation
   -------------------------- */
let world = []; // 2D array world[y][x] = tile object or null
function genWorld(){
  world = [];
  for(let y=0;y<WORLD_H;y++){
    const row = [];
    for(let x=0;x<WORLD_W;x++){
      // default dirt near top, deeper -> more stone & ores
      const depthRatio = y / WORLD_H;
      // create base chance for ores based on depth
      let tile = { id:'dirt', hardness:1, hp:1, ore:null };
      // determine tile type probabilistically
      // stone baseline
      if(y > SURFACE_ROW){
        const stoneChance = Math.min(0.7 + depthRatio*0.2, 0.95);
        if(Math.random() < stoneChance) tile.id = 'stone', tile.hardness = 2, tile.hp = 2;
      }
      // sample ores by rarity depending on depth
      for(let ore of ORE_TYPES.slice(2)){ // skip dirt & stone
        // scale rarity with depth: deeper -> rarer ores become more likely
        const chance = ore.rarity * (0.8 + depthRatio*2.5);
        if(Math.random() < chance){
          tile.id = ore.id; tile.hardness = ore.hardness; tile.hp = ore.hardness; tile.ore = ore.id;
          break;
        }
      }
      // occasionally leave diamond pockets
      if(Math.random() < 0.002 + depthRatio*0.002){
        tile.id='diamond'; tile.hardness=6; tile.hp=6; tile.ore='diamond';
      }
      // surface rows become light dirt with plants (visual only)
      if(y <= SURFACE_ROW){
        tile.id='dirt'; tile.hardness=1; tile.hp=1; tile.ore=null;
      }
      row.push(tile);
    }
    world.push(row);
  }
}
genWorld();

/* --------------------------
   Rendering (canvas)
   -------------------------- */
const canvas = $('#game-canvas');
const ctx = canvas.getContext('2d');
let canvasScale = 1;

// pixel scaling for crisp look
function resizeCanvas(){
  // keep aspect ratio: tilesize * VIEW_W / VIEW_H
  const devicePixelRatio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = rect.height * devicePixelRatio;
  ctx.imageSmoothingEnabled = false;
  canvasScale = canvas.width / (VIEW_W * TILE_SIZE);
}
window.addEventListener('resize', resizeCanvas);
setTimeout(resizeCanvas, 50);

/* camera lerp */
let cameraY = 0;
function updateCamera(){
  const targetY = state.player.y - Math.floor(VIEW_H/2);
  cameraY += (targetY - cameraY) * 0.14; // smooth follow
  // clamp
  cameraY = Math.max(0, Math.min(WORLD_H - VIEW_H, cameraY));
}

/* draw world tiles */
function getTile(y,x){ if(y<0 || y>=WORLD_H || x<0||x>=WORLD_W) return null; return world[y][x]; }
function draw(){
  // clear
  ctx.clearRect(0,0,canvas.width,canvas.height);

  // draw sky/surface gradient background
  // determine top visible row
  const topRow = Math.floor(cameraY);
  // vertical pixel scale per tile
  const tilePixel = TILE_SIZE * canvasScale;

  // background: gradient shifts darker as deeper
  const grd = ctx.createLinearGradient(0,0,0,canvas.height);
  grd.addColorStop(0,'#7ec4ff'); grd.addColorStop(0.35,'#3fa3d9'); grd.addColorStop(1,'#0b2a2b');
  ctx.fillStyle = grd;
  ctx.fillRect(0,0,canvas.width,canvas.height);

  // draw tiles
  for(let vy=0; vy<VIEW_H; vy++){
    for(let vx=0; vx<VIEW_W; vx++){
      const wy = topRow + vy;
      const tile = getTile(wy,vx);
      const px = vx * tilePixel;
      const py = vy * tilePixel;
      if(!tile){ // void
        ctx.fillStyle = '#000';
        ctx.fillRect(px,py,tilePixel,tilePixel);
        continue;
      }
      // darker color with depth
      let col = '#6b4f2b';
      const depthFactor = Math.min(1, (wy / WORLD_H));
      if(tile.id === 'dirt') col = '#8b6b3a';
      else if(tile.id === 'stone') col = '#6a6a6a';
      else if(tile.id === 'coal') col = '#111111';
      else if(tile.id === 'iron') col = '#bfbfbf';
      else if(tile.id === 'gold') col = '#ffd54a';
      else if(tile.id === 'diamond') col = '#80e0ff';

      // darken color slightly with depth
      ctx.fillStyle = shadeColor(col, -Math.floor(depthFactor * 30));
      ctx.fillRect(px,py,tilePixel,tilePixel);

      // draw subtle pattern/pixels for texture
      ctx.fillStyle = shadeColor(col, -10);
      for(let i=0;i<3;i++){
        ctx.fillRect(px+Math.random()*tilePixel, py+Math.random()*tilePixel, Math.max(1, Math.floor(tilePixel*0.06)), Math.max(1, Math.floor(tilePixel*0.06)));
      }
      // if tile has hp less than max show cracks (simple)
      if(tile.hp < tile.hardness){
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = Math.max(1, Math.floor(tilePixel*0.08));
        ctx.beginPath();
        ctx.moveTo(px + tilePixel*0.1, py + tilePixel*0.1);
        ctx.lineTo(px + tilePixel*0.9, py + tilePixel*0.9);
        ctx.stroke();
      }
    }
  }

  // draw player (centered in view)
  const playerScreenY = (state.player.y - topRow) * tilePixel;
  const playerScreenX = (state.player.x) * tilePixel;
  drawPlayer(playerScreenX, playerScreenY, tilePixel);

  // draw HUD overlays e.g., depth
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(6, canvas.height - 28, 140, 20);
  ctx.fillStyle = '#fff';
  ctx.font = `${12 * canvasScale}px ${'Courier New'}`;
  ctx.fillText(`Depth: ${state.player.y}`, 10 * canvasScale, canvas.height - 12);
}

/* draw a simple pixelated miner */
function drawPlayer(px, py, tilePixel){
  const w = tilePixel * 0.9, h = tilePixel * 0.9;
  ctx.fillStyle = '#ffcc99';
  ctx.fillRect(px+tilePixel*0.05, py+tilePixel*0.05, w*0.45, h*0.45); // body
  ctx.fillStyle = '#333';
  ctx.fillRect(px+tilePixel*0.53, py+tilePixel*0.05, w*0.25, h*0.08); // helmet stripe
  // pickaxe
  ctx.strokeStyle = '#bfbfbf';
  ctx.lineWidth = Math.max(1, Math.floor(tilePixel*0.06));
  ctx.beginPath();
  ctx.moveTo(px + w*0.9, py + h*0.5);
  ctx.lineTo(px + w*1.2, py + h*0.25);
  ctx.stroke();
}

/* color utility */
function shadeColor(color, percent) {
  // color in hex like #rrggbb
  let R = parseInt(color.substring(1,3),16);
  let G = parseInt(color.substring(3,5),16);
  let B = parseInt(color.substring(5,7),16);
  R = parseInt(R * (100 + percent) / 100);
  G = parseInt(G * (100 + percent) / 100);
  B = parseInt(B * (100 + percent) / 100);
  R = (R<255)?R:255;G=(G<255)?G:255;B=(B<255)?B:255;
  const rr = (R.toString(16).length==1)?'0'+R.toString(16):R.toString(16);
  const gg = (G.toString(16).length==1)?'0'+G.toString(16):G.toString(16);
  const bb = (B.toString(16).length==1)?'0'+B.toString(16):B.toString(16);
  return `#${rr}${gg}${bb}`;
}

/* --------------------------
   Player input & movement
   -------------------------- */
const keys = {};
window.addEventListener('keydown', (e)=>{
  keys[e.key.toLowerCase()] = true;
  // resume audio context on first input
  if(sfx.ctx && sfx.ctx.state === 'suspended') sfx.ctx.resume();
});
window.addEventListener('keyup', (e)=>{ keys[e.key.toLowerCase()] = false; });

/* movement */
let moveCooldown = 0;
function playerTick(dt){
  // movement: Left/Right
  const speed = 1; // tiles per keypress tick
  moveCooldown -= dt;
  if(moveCooldown <= 0){
    if(keys['arrowleft'] || keys['a']){ tryMove(-1,0); moveCooldown = 0.06; }
    else if(keys['arrowright'] || keys['d']){ tryMove(1,0); moveCooldown = 0.06; }
    else if(keys['arrowdown'] || keys['s']){ tryMove(0,1); moveCooldown = 0.06; }
  }
}

/* try move to tile if empty or within bounds */
function tryMove(dx,dy){
  const nx = state.player.x + dx;
  const ny = state.player.y + dy;
  if(nx < 0 || nx >= WORLD_W || ny < 0 || ny >= WORLD_H) return;
  // check tile solidity: if it's not mined (we represent mined as null)
  const tile = getTile(ny,nx);
  if(tile && tile.id !== 'air' && tile.hp > 0){
    // can't move through solid blocks
    return;
  }
  // move
  state.player.x = nx;
  state.player.y = ny;
}

/* --------------------------
   Mining
   -------------------------- */
let lastMineTime = 0;
function canMineTile(tx, ty){
  // can mine only adjacent (left/right/down/up) or below/adjacent as requested
  const px = state.player.x, py = state.player.y;
  const dx = Math.abs(tx - px), dy = Math.abs(ty - py);
  if(dx + dy === 1 || (dx === 0 && ty === py+1)) return true;
  return false;
}

function mineTile(tx, ty){
  const tile = getTile(ty, tx);
  if(!tile || tile.hp <= 0) return;
  if(!canMineTile(tx,ty)) { popup('Cannot reach'); return; }
  // mining requires tool: reduce hp by pick power
  const pickPower = Math.max(1, state.pickLevel); // pickLevel reduces hits needed
  tile.hp -= pickPower;
  sfx.mine();
  createParticles(tx, ty);
  if(tile.hp <= 0){
    // collect ore if any
    if(tile.ore){
      addToInventory(tile.ore, 1);
      // floating +popup
      popFloating(`+${ORE_TYPES.find(o=>o.id===tile.ore).value}`, tx, ty);
    } else {
      // dirt fallback value
      addToInventory('dirt', 1);
      popFloating('+1', tx, ty);
    }
    // set tile to null/missing (air)
    world[ty][tx] = { id:'air', hardness:0, hp:0, ore:null };
    sfx.click();
  }
}

/* particle effects minimal */
const particles = [];
function createParticles(tx,ty){
  const topRow = Math.floor(cameraY);
  const tilePixel = TILE_SIZE * canvasScale;
  const px = (tx) * tilePixel;
  const py = (ty - topRow) * tilePixel;
  for(let i=0;i<8;i++){
    particles.push({
      x: px + Math.random()*tilePixel,
      y: py + Math.random()*tilePixel,
      vx: (Math.random()-0.5)*2,
      vy: -Math.random()*2,
      life: 30 + Math.random()*30,
      col: '#bfbfbf'
    });
  }
}
function renderParticles(){
  const tilePixel = TILE_SIZE * canvasScale;
  particles.forEach(p=>{
    ctx.fillStyle = p.col;
    ctx.fillRect(p.x, p.y, Math.max(1, Math.floor(tilePixel*0.06)), Math.max(1, Math.floor(tilePixel*0.06)));
    p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.life--;
  });
  // remove dead
  for(let i=particles.length-1;i>=0;i--) if(particles[i].life<=0) particles.splice(i,1);
}

/* floating pop from world coords */
function popFloating(text, tx, ty){
  const node = document.createElement('div');
  node.className = 'popup';
  node.textContent = text;
  node.style.position = 'absolute';
  node.style.pointerEvents = 'none';
  // position near canvas relative
  const rect = canvas.getBoundingClientRect();
  const topRow = Math.floor(cameraY);
  const tilePixel = (rect.width / VIEW_W);
  const sx = rect.left + tx * tilePixel;
  const sy = rect.top + (ty - topRow) * tilePixel;
  node.style.left = `${sx + tilePixel/2}px`;
  node.style.top = `${sy}px`;
  document.body.appendChild(node);
  setTimeout(()=> node.remove(), 900);
}

/* add to inventory with capacity check */
function addToInventory(oreId, qty){
  let total = 0;
  for(const k in state.inventory) total += state.inventory[k];
  if(total + qty > state.invCapacity){
    popup('Inventory full!');
    return;
  }
  state.inventory[oreId] = (state.inventory[oreId]||0) + qty;
  refreshInventoryUI();
  saveState();
}

/* --------------------------
   Inventory & selling
   -------------------------- */
function refreshInventoryUI(){
  const list = $('#inventory-list');
  list.innerHTML = '';
  // create entries for all known ores (even 0 count)
  const displayOres = ['dirt','coal','iron','gold','diamond'];
  for(let id of displayOres){
    const def = ORE_TYPES.find(o=>o.id === id) || {name: id, value: (id==='dirt'?1:0)};
    const count = state.inventory[id] || 0;
    const row = document.createElement('div');
    row.className = 'inv-item';
    row.innerHTML = `<div class="inv-name"><span class="ore-swatch" style="background:${def.color || '#444'}"></span><strong>${def.name}</strong></div><div>${count}</div>`;
    list.appendChild(row);
  }
  // cap
  const total = Object.values(state.inventory).reduce((a,b)=>a+(b||0),0);
  $('#cap-val').textContent = `${total}/${state.invCapacity}`;
  $('#money-display').textContent = `💰 ${state.money}`;
  // energy
  const fill = Math.max(0, Math.min(1, state.energy / state.maxEnergy)) * 100;
  $('#energy-fill').style.width = `${fill}%`;
}

/* Sell all function (only at surface) */
function atSurface(){
  return state.player.y <= SURFACE_ROW;
}
function sellAll(){
  if(!atSurface()){
    popup('You must be at the surface to sell');
    return;
  }
  // compute value
  let earned = 0;
  for(const id in state.inventory){
    const count = state.inventory[id]||0;
    if(count<=0) continue;
    const def = ORE_TYPES.find(o=>o.id===id) || {value:1};
    earned += def.value * count;
    state.inventory[id] = 0;
  }
  if(earned === 0){ popup('Nothing to sell'); return; }
  state.money += earned;
  refreshInventoryUI();
  popup(`+ $${earned}`);
  sfx.sell();
  // coin float
  createFloatingMoney(`+$${earned}`);
  saveState();
}

/* floating money at top */
function createFloatingMoney(text){
  const node = document.createElement('div');
  node.className = 'popup';
  node.textContent = text;
  $('#popups').appendChild(node);
  setTimeout(()=> node.remove(), 1400);
}

/* --------------------------
   Shop & Upgrades
   -------------------------- */
function openShop(){
  $('#shop-modal').classList.remove('hidden');
  $('#shop-upgrade-list').innerHTML = '';
  for(let u of UPGRADES){
    const owned = !!state.upgradesOwned[u.id];
    const row = document.createElement('div');
    row.className = 'upgrade';
    row.innerHTML = `
      <div>
        <strong>${u.name}</strong>
        <div style="font-size:12px;color:#aaa">${u.desc}</div>
      </div>
      <div style="text-align:right">
        <div style="margin-bottom:6px">$${u.cost}</div>
        <button class="pixel-btn" data-id="${u.id}" ${owned?'disabled':''}>${owned?'Owned':'Buy'}</button>
      </div>`;
    $('#shop-upgrade-list').appendChild(row);
  }
}
function buyUpgrade(id){
  const u = UPGRADES.find(x=>x.id===id);
  if(!u) return;
  if(state.money < u.cost){ popup('Not enough money'); return; }
  state.money -= u.cost;
  state.upgradesOwned[u.id] = true;
  u.apply(state);
  sfx.buy();
  popup('Upgrade Purchased!');
  refreshInventoryUI();
  saveState();
  openShop(); // refresh UI to mark owned
}

/* --------------------------
   UI bindings
   -------------------------- */
$('#sell-btn').addEventListener('click', ()=>{ sellAll(); });
$('#shop-btn').addEventListener('click', ()=>{ openShop(); });
$('#shop-close').addEventListener('click', ()=>{ $('#shop-modal').classList.add('hidden'); });

$('#save-btn').addEventListener('click', ()=> saveState());
$('#reset-btn').addEventListener('click', ()=> { if(confirm('Reset save?')) resetSave(); });

$('#mute-btn').addEventListener('click', ()=>{
  if(!sfx.ctx) { sfx.ensure(); }
  sfx.gain.gain.value = sfx.gain.gain.value > 0.02 ? 0 : 0.12;
  $('#mute-btn').textContent = sfx.gain.gain.value > 0 ? '🔊' : '🔇';
});

/* shop buy handlers (delegation) */
$('#shop-upgrade-list').addEventListener('click', (e)=>{
  const btn = e.target.closest('button[data-id]');
  if(btn) buyUpgrade(btn.getAttribute('data-id'));
});

/* canvas mining by click */
canvas.addEventListener('click', (e)=>{
  const rect = canvas.getBoundingClientRect();
  const tilePixel = rect.width / VIEW_W;
  const tx = Math.floor((e.clientX - rect.left) / tilePixel);
  const ty = Math.floor((e.clientY - rect.top) / tilePixel) + Math.floor(cameraY);
  mineTile(tx, ty);
  refreshInventoryUI();
});

/* mining key (space or enter) mines tile below player if any */
window.addEventListener('keydown', (e)=>{
  if(e.code === 'Space' || e.key === 'Enter'){
    e.preventDefault();
    const tx = state.player.x;
    const ty = state.player.y + 1;
    mineTile(tx, ty);
    refreshInventoryUI();
  }
});

/* --------------------------
   Save auto/load on start
   -------------------------- */
const hasSave = loadState();
refreshInventoryUI();

/* --------------------------
   Game loop
   -------------------------- */
let lastTime = performance.now();
function loop(ts){
  const dt = (ts - lastTime) / 1000;
  lastTime = ts;
  playerTick(dt);
  updateCamera();
  draw();
  renderParticles();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* --------------------------
   Helpers & UI initialization
   -------------------------- */

// fill upgrades UI on right side (quick access)
function initUpgradesPanel(){
  const container = $('#upgrades-list');
  container.innerHTML = '';
  for(let u of UPGRADES){
    const owned = !!state.upgradesOwned[u.id];
    const el = document.createElement('div');
    el.className = 'upgrade';
    el.innerHTML = `<div><strong>${u.name}</strong><div style="font-size:12px;color:#aaa">${u.desc}</div></div>
      <div>
        <div style="text-align:right;margin-bottom:6px">$${u.cost}</div>
        <button class="pixel-btn" data-id="${u.id}" ${owned? 'disabled':''}>${owned? 'Owned':'Buy'}</button>
      </div>`;
    container.appendChild(el);
  }
}
initUpgradesPanel();
$('#upgrades-list').addEventListener('click', (e)=>{
  const btn = e.target.closest('button[data-id]');
  if(btn) buyUpgrade(btn.getAttribute('data-id'));
});

// title screen behavior (start/continue)
function setupTitleScreen(){
  const overlay = $('#title-screen');
  const continueBtn = $('#continue-btn');
  if(hasSave) overlay.classList.remove('hidden');
  else overlay.classList.add('hidden');
  $('#start-btn').addEventListener('click', ()=> overlay.classList.add('hidden'));
  continueBtn.addEventListener('click', ()=> overlay.classList.add('hidden'));
  $('#reset-save-btn').addEventListener('click', ()=> { if(confirm('Reset Save?')) { resetSave(); } });
}
setupTitleScreen();

/* refresh inventory on load */
refreshInventoryUI();

/* utility: draw loop tick to redraw particles as part of draw */
(function attachRenderParticlesToDraw(){
  const origDraw = draw;
  draw = function(){
    origDraw();
    renderParticles();
  };
})();

console.log('GoldDigger loaded');
