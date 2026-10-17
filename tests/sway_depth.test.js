import { buildSwayBraces, buildSwayRib, swayAtFace, swayClashes, swayClashesWall, SWAY } from '../web/sway.js';
import { findWallPatches, tAtZ } from '../web/planes.js';
import { block, blockTopo, buildTopology, analyze, assert, assertClose, isClosed,
  isOriented, fins, prop, insideCount, readSTL, rotX } from './_util.js';
import { writeBinarySTL } from '../web/stl.js';
import { writeThreeMF, readThreeMF } from '../web/threemf.js';
const ID = [1,0,0,0,1,0,0,0,1];
const post = () => blockTopo(-80,80,-60,60,0,1000);
const opts = { tines:true, layerHeight:0.6, reach:0.15 };
const side = (topo, ny, y) => Array.from({length:topo.nFaces},(_,i)=>i)
  .find((i)=>topo.nrm[i*3+1]*ny > 0.9 && Math.abs(topo.pos[i*9+1]-y)<1e-6);

Deno.test('Sway Draw: seating ignores protrusions above the height cap on either side and leaning faces', () => {
  const topo=blockTopo(-40,40,-15,15,0,200);
  for (const angle of [-20,0,20]) {
    const rot=rotX(angle), result=analyze(topo,45,rot), o=result.offset;
    const partTris=Float64Array.from(topo.pos, (v,i)=> {
      const k=i%3, j=i-k;
      return rot[k]*topo.pos[j]+rot[k+3]*topo.pos[j+1]+rot[k+6]*topo.pos[j+2]+[o.x,o.y,o.z][k];
    });
    const patches=findWallPatches(topo,rot,o);
    for (const sign of [-1,1]) {
      const p=patches.find((p)=>p.n.y*sign>0.9);
      assert(p, 'missing side patch');
      const uc=(p.u0+p.u1)/2;
      const bump=[[-2,150],[2,150],[2,200],[-2,150],[2,200],[-2,200]]
        .flatMap(([u,z])=>[uc+u,tAtZ(p,0.8,z),0.8]);
      const q={...p,tris:Float64Array.from([...p.tris,...bump])};
      const build=(patch,extra)=>buildSwayRib(patch,uc,partTris,topo,rot,o,{tines:false,gap:0.2,...extra});
      const low=build(q,{maxHeight:80}), clean=build(p,{maxHeight:80}), full=build(q,{});
      assert(low.ok && clean.ok && full.ok, low.reason ?? clean.reason ?? full.reason);
      assertClose(low.height,80,1e-6);
      assert(JSON.stringify(low.tris)===JSON.stringify(clean.tris), 'upper protrusion moves a low brace');
      const s=(r)=>r.levels[0].a[0]*p.n.x/p.h+r.levels[0].a[1]*p.n.y/p.h;
      assertClose(s(full)-s(low),0.8/p.h,1e-6,'uncapped control does not include the protrusion');
      assert(isClosed(low.tris) && isOriented(low.tris));
    }
  }
});

Deno.test('Sway tines: contact offset moves the tips without moving the body or tine roots', () => {
  const topo=blockTopo(-40,40,-15,15,0,200), result=analyze(topo,45,ID), face=side(topo,-1,-15);
  const plain=swayAtFace(topo,result,ID,face,[0,-15,80],{...opts,tines:false});
  const legacy=swayAtFace(topo,result,ID,face,[0,-15,80],opts);
  const explicit=swayAtFace(topo,result,ID,face,[0,-15,80],{...opts,tineContactOffset:-0.01});
  assert(plain.ok && legacy.ok && explicit.ok);
  assert(JSON.stringify(legacy.tris)===JSON.stringify(explicit.tris), 'default contact changed');
  for (const tineContactOffset of [-0.1,0,0.1]) {
    const r=swayAtFace(topo,result,ID,face,[0,-15,80],{...opts,tineContactOffset});
    assert(r.ok && r.tines===legacy.tines);
    assert(JSON.stringify(r.tris.slice(0,plain.tris.length))===JSON.stringify(plain.tris), 'body moved');
    const tips=r.tris.slice(plain.tris.length), roots=legacy.tris.slice(plain.tris.length);
    assertClose(Math.max(...tips.map((v)=>v[1])),-15-tineContactOffset,1e-3);
    assertClose(Math.min(...tips.map((v)=>v[1])),Math.min(...roots.map((v)=>v[1])),1e-9);
    assert(isClosed(r.tris) && isOriented(r.tris));
  }
});

Deno.test('Sway depth: default/off is identical; opt-in reaches 5/15/50% with the original gauge and grip', () => {
  const topo=post(), result=analyze(topo,45,ID);
  const legacy=buildSwayBraces(topo,result,ID,opts);
  const off=buildSwayBraces(topo,result,ID,{...opts,uncappedDepth:false});
  assert(JSON.stringify(off)===JSON.stringify(legacy), 'off changes legacy geometry');
  for (const reach of [0.05,0.15,0.5]) {
    const b=buildSwayBraces(topo,result,ID,{...opts,reach,uncappedDepth:true});
    assert(b.count>=2 && isClosed(b.triangles) && isOriented(b.triangles));
    for (const r of b.ribs) {
      assertClose(r.depth,r.height*reach,1e-6);
      assert(r.tines>=3 && r.th===2.4, 'gauge or minimum grip changed');
    }
  }
  for (const r of legacy.ribs) assertClose(r.depth,60,1e-6);
  const short=blockTopo(-20,20,-15,15,0,150), res=analyze(short,45,ID);
  assert(JSON.stringify(buildSwayBraces(short,res,ID,opts))===
    JSON.stringify(buildSwayBraces(short,res,ID,{...opts,uncappedDepth:true})), 'short brace unnecessarily changes');
});

Deno.test('Sway depth: expanded Draw foot still refuses a wall beyond the old 60 mm footprint', () => {
  const topo=post(), result=analyze(topo,45,ID), face=side(topo,-1,-60);
  const normal=swayAtFace(topo,result,ID,face,[0,-60,1000],opts);
  const full=swayAtFace(topo,result,ID,face,[0,-60,1000],{...opts,uncappedDepth:true});
  assert(normal.ok && full.ok);
  const p=full.foot[0].map((v,i)=>v+0.85*(full.foot[1][i]-v));
  const wall=[[p[0]-10,p[1],0],[p[0]+10,p[1],0]];
  assert(!swayClashesWall(normal,[wall]) && swayClashesWall(full,[wall]));
  const blocked=swayAtFace(topo,result,ID,face,[0,-60,1000],{...opts,uncappedDepth:true},{walls:[wall]});
  assert(!blocked.ok && /would fuse/.test(blocked.reason), 'expanded foot ignores existing wall');
});

Deno.test('Sway depth: deeper braces facing across a channel still refuse overlapping supports', () => {
  const pos=Float32Array.from([...block(-40,40,-160,-100,0,1000),...block(-40,40,100,160,0,1000)]);
  const topo=buildTopology({getAttribute:()=>({array:pos})}), result=analyze(topo,45,ID);
  const a=side(topo,1,-100), b=side(topo,-1,100), full={...opts,uncappedDepth:true};
  const first=swayAtFace(topo,result,ID,a,[0,-100,1000],full);
  assert(first.ok, first.reason);
  const across=swayAtFace(topo,result,ID,b,[0,100,1000],full,[first]);
  assert(!across.ok && /another brace/.test(across.reason), 'opposing deeper braces overlap');
});

Deno.test('Sway depth: a model obstacle in the expanded footprint is still rejected', () => {
  const pos=Float32Array.from([...block(-80,80,-60,60,0,1000),...block(-5,5,-200,-170,0,50)]);
  const topo=buildTopology({getAttribute:()=>({array:pos})}), result=analyze(topo,45,ID), face=side(topo,-1,-60);
  assert(swayAtFace(topo,result,ID,face,[0,-60,1000],opts).ok, 'control brace is blocked');
  const full=swayAtFace(topo,result,ID,face,[0,-60,1000],{...opts,uncappedDepth:true});
  assert(!full.ok && typeof full.reason==='string', 'expanded brace passes through obstacle');
});

Deno.test('Sway depth: an overhead shoulder shortens the rib and recomputes depth from its actual height', () => {
  const pos=Float32Array.from([...block(-80,80,-60,60,0,1000),...block(-8,8,-150,-60,300,310)]);
  const topo=buildTopology({getAttribute:()=>({array:pos})}), result=analyze(topo,45,ID), face=side(topo,-1,-60);
  const r=swayAtFace(topo,result,ID,face,[0,-60,400],{...opts,reach:0.5,uncappedDepth:true});
  assert(r.ok, r.reason);
  assert(r.height<300 && r.height>200, 'shoulder did not shorten the rib');
  assertClose(r.depth,r.height*0.5,1e-6,'depth still uses original part height');
});

Deno.test('Sway depth: real Auto worker switches full depth on/off without retaining it', async () => {
  const topology=post(), result=analyze(topology,45,ID);
  const worker=new Worker(new URL('../web/finworker.js',import.meta.url).href,{type:'module'});
  try {
    let id=0;
    for (const uncappedDepth of [true,false,true]) {
      const requestOpts={mode:'auto',tines:true,layerHeight:0.6,
        sway:{on:true,reach:0.15,uncappedDepth},tunables:{iface:false}};
      const wireTopo={...topology};
      delete wireTopo._insideGrid; // The page omits its function-valued ray cache too.
      const reply=await new Promise((resolve,reject)=> {
        worker.onmessage=({data})=>resolve(data);worker.onerror=(e)=>reject(new Error(e.message));
        worker.postMessage({id:++id,topology:wireTopo,result,rot:ID,opts:requestOpts});
      });
      assert(!reply.error,reply.error);
      assert(reply.built.sway.count>=2);
      const records=reply.built.fins.filter(r=>r.kind==='sway');
      assert(records.length>=2);
      for (const r of records) {
        assert(Number.isFinite(r.length),'worker omitted measured brace depth');
        assertClose(r.length,uncappedDepth?r.height*0.15:60,1e-6);
      }
      assert(JSON.stringify(reply.built.triangles)===
        JSON.stringify(fins.buildFins(topology,result,ID,requestOpts).triangles), 'worker geometry differs');
    }
  } finally { worker.terminate(); }
});

Deno.test('Sway depth: metre-high ownership, interface clearance and STL/3MF export remain intact', async () => {
  const topo=post(), result=analyze(topo,45,ID);
  const b=fins.buildFins(topo,result,ID,{mode:'auto',tines:true,layerHeight:0.6,
    sway:{on:true,uncappedDepth:true},tunables:{iface:'all'}});
  const claims=new Uint8Array(b.triangles.length);
  for (const f of b.fins) for (const [lo,hi] of f.triRanges) {
    assert(isClosed(b.triangles.slice(lo,hi)), 'removal range loses part of the brace');
    for(let i=lo;i<hi;i++)claims[i]++;
  }
  assert(claims.every(n=>n===1),'unowned or multiply-owned geometry');
  const {body,iface}=prop.splitInterface(b.triangles);
  assert(isClosed(body) && isClosed(iface) && isOriented(body) && isOriented(iface));
  // Probe just above the coplanar plate face, where ray parity is unambiguous.
  assert(insideCount(topo,ID,result.offset,body.map(v=>[v[0],v[1],Math.max(v[2],0.001)]))===0,
    'brace body enters the post');
  assert(iface.length/36===b.sway.tines,'tine interface tags lost');
  const stl=new Uint8Array(await writeBinarySTL(b.triangles).arrayBuffer());
  assert(readSTL(stl).length===b.triangles.length*3);
  const part=Array.from({length:topo.pos.length/3},(_,i)=>Array.from(topo.pos.slice(i*3,i*3+3)));
  const data=new Uint8Array(await writeThreeMF(part,body,'synthetic-post',{separate:true,iface,
    session:{v:1,form:{'full-brace-depth':true}}}).arrayBuffer());
  const restored=await readThreeMF(data);
  assert(restored.session.form['full-brace-depth']===true);
  assert(restored.objects[1].positions.length===b.triangles.length*3,'3MF loses support geometry');
  fins.applyTunables({iface:false});
});

Deno.test('Sway cross: over the start height the brace gets a cross rib each way along the side', () => {
  const topo=post(), result=analyze(topo,45,ID), face=side(topo,-1,-60);
  const plain=swayAtFace(topo,result,ID,face,[0,-60,400],opts);
  const ribbed=swayAtFace(topo,result,ID,face,[0,-60,400],{...opts,crossAbove:10});
  assert(plain.ok && ribbed.ok, plain.reason ?? ribbed.reason);
  assert(!plain.cross && !plain.arms.length, 'no cross ribs unless the threshold is set');
  assert(ribbed.cross===2, `one each way along the side: ${ribbed.cross}`);
  assert(ribbed.tris.length>plain.tris.length, 'the cross ribs are in the brace');
  for (const a of ribbed.arms) {
    assert(a.a[2]===0 && a.b[2]===0, 'a cross rib stands on the plate');
    const dx=Math.abs(a.b[0]-a.a[0]), dy=Math.abs(a.b[1]-a.a[1]);
    assert(dx>ribbed.halfW, `a cross rib reaches ${dx.toFixed(1)}mm along the side`);
    assert(dy<1e-6, 'a cross rib runs ALONG the face, not out of it');
  }
  assert(Math.sign(ribbed.arms[0].b[0]-ribbed.arms[0].a[0])===
    -Math.sign(ribbed.arms[1].b[0]-ribbed.arms[1].a[0]), 'the two go opposite ways');
  const cross=ribbed.tris.slice(plain.tris.length);
  assert(isClosed(cross) && isOriented(cross), 'a cross rib is a closed, outward-wound solid');
  assert(insideCount(topo,ID,result.offset,cross.map(v=>[v[0],v[1],Math.max(v[2],0.001)]))===0,
    'a cross rib enters the post');
  const crossH=Math.max(...cross.map(v=>v[2]));
  assertClose(crossH,Math.min(prop.BRACE.rise*ribbed.height,ribbed.height-1),1e-6,
    'cross-rib height must follow brace height, not base depth');
  assert(crossH>ribbed.depth && crossH<ribbed.height, 'cross rib is too short or pokes out of the brace top');
});

Deno.test('Sway cross: height ratio is adjustable without changing the brace or horizontal reach', () => {
  const topo=blockTopo(-40,40,-15,15,0,200), result=analyze(topo,45,ID), face=side(topo,-1,-15);
  const plain=swayAtFace(topo,result,ID,face,[0,-15,80],opts);
  const reference=swayAtFace(topo,result,ID,face,[0,-15,80],{...opts,crossAbove:10});
  assert(plain.ok && reference.ok && reference.cross===2);
  for (const [crossRise,want] of [[0.1,0.1],[0.3,0.3],[0.5,0.5],[0.9,0.9],[-1,0.1],[2,0.9],[NaN,0.5]]) {
    const r=swayAtFace(topo,result,ID,face,[0,-15,80],{...opts,crossAbove:10,crossRise});
    assert(r.ok && r.cross===2, `missing cross ribs at ratio ${crossRise}`);
    const cross=r.tris.slice(plain.tris.length);
    assertClose(Math.max(...cross.map((v)=>v[2])),Math.min(want*r.height,r.height-1),1e-6);
    assert(JSON.stringify(r.tris.slice(0,plain.tris.length))===JSON.stringify(plain.tris),
      'height ratio changed the brace, foot or tines');
    assert(JSON.stringify(r.arms.map((a)=>[a.a,a.b,a.th]))===
      JSON.stringify(reference.arms.map((a)=>[a.a,a.b,a.th])), 'height ratio changed horizontal reach');
    assert(isClosed(cross) && isOriented(cross));
    assert(insideCount(topo,ID,result.offset,cross.map((v)=>[v[0],v[1],Math.max(0.001,v[2])]))===0);
  }
});

Deno.test('Sway cross: a cross rib blocked by a support wall stops short, never fused', () => {
  const topo=post(), result=analyze(topo,45,ID), face=side(topo,-1,-60);
  const wall=[[40,-140,0],[40,-100,0]];
  const blocked=swayAtFace(topo,result,ID,face,[0,-60,1000],{...opts,crossAbove:10},{walls:[wall]});
  assert(blocked.ok, 'a blocked cross rib must not refuse the brace');
  assert(blocked.cross===2, `both sides still land: ${blocked.cross}`);
  const plus=blocked.arms.find((a)=>a.b[0]>0);
  assert(plus && plus.b[0]<40-SWAY.wallHalf-SWAY.clearance,
    `the +x arm stops at ${plus?.b[0].toFixed(1)}mm, short of the wall`);
  const free=swayAtFace(topo,result,ID,face,[0,-60,1000],{...opts,crossAbove:10});
  const deep=free.arms.find((a)=>a.b[0]>0).b[0];
  assert(deep>50 && deep<=free.depth+1e-9, `unblocked it reaches ${deep.toFixed(1)}mm, capped at the brace depth`);
  const plain=swayAtFace(topo,result,ID,face,[0,-60,1000],opts);
  assert(plain.ok && plain.tris.length<blocked.tris.length);
});

Deno.test('Sway cross: stems follow the tapered outer edge on upright and leaning faces', () => {
  const topo=blockTopo(-40,40,-15,15,0,200), face=side(topo,-1,-15);
  for (const angle of [-20,0,20]) {
    const rot=rotX(angle), result=analyze(topo,45,rot);
    const point=[0,rot[4]*-15+rot[7]*80,rot[5]*-15+rot[8]*80];
    const plain=swayAtFace(topo,result,rot,face,point,opts);
    const r=swayAtFace(topo,result,rot,face,point,{...opts,crossAbove:10});
    assert(plain.ok && r.ok && r.cross===2, `cross ribs at ${angle} degrees: ${r.reason}`);
    const cross=r.tris.slice(plain.tris.length), mid=r.levels[Math.floor(r.levels.length/2)];
    const base=r.levels[0].b, slope=(mid.b[1]-base[1])/mid.z;
    const stemH=Math.max(...cross.map((v)=>v[2]));
    const tipOuter=base[1]+slope*stemH;
    for (const v of cross.filter((v)=>Math.abs(v[2]-stemH)<1e-6)) {
      assert(Math.abs(v[0])<=r.th/2 && v[1]>tipOuter+0.05
        && v[1]<tipOuter+prop.PROP.th+0.2, `exposed root tip at ${angle} degrees`);
    }
    for (let z=SWAY.footH+1; z<stemH; z+=1) {
      const roots=[];
      for (let i=0;i<cross.length;i+=3) for (let e=0;e<3;e++) {
        const a=cross[i+e], b=cross[i+(e+1)%3];
        if ((a[2]<z)===(b[2]<z)) continue;
        const f=(z-a[2])/(b[2]-a[2]);
        const x=a[0]+f*(b[0]-a[0]), y=a[1]+f*(b[1]-a[1]);
        if (Math.abs(x)<prop.PROP.th/2+1e-6) roots.push(y);
      }
      const outer=base[1]+slope*z;
      assert(roots.some((y)=>y>outer+0.05 && y<outer+prop.PROP.th),
        `stem detached from the plate at ${angle} degrees, z=${z}`);
    }
    assert(isClosed(cross) && isOriented(cross));
    assert(insideCount(topo,rot,result.offset,cross.map((v)=>[v[0],v[1],Math.max(0.001,v[2])]))===0);
  }
});

Deno.test('Sway cross: wall avoidance is rotation invariant and includes flange clearance', () => {
  const topo=post(), face=side(topo,-1,-60);
  for (const angle of [0,45,90,135]) {
    const a=angle*Math.PI/180, c=Math.cos(a), s=Math.sin(a), rot=[c,s,0,-s,c,0,0,0,1];
    const turn=([x,y,z])=>[c*x-s*y,s*x+c*y,z];
    const result=analyze(topo,45,rot), point=turn([0,-60,400]);
    const wall=[turn([40,-121,0]),turn([40,-119,0])];
    const r=swayAtFace(topo,result,rot,face,point,{...opts,crossAbove:10},{walls:[wall]});
    assert(r.ok && r.cross===2, `wall avoidance at ${angle} degrees`);
    const plus=r.arms.find((arm)=>arm.b[0]*c+arm.b[1]*s>1);
    assert(plus && plus.b[0]*c+plus.b[1]*s<40-SWAY.wallHalf-SWAY.clearance,
      `rotated arm ignored the wall at ${angle} degrees`);
  }
});

Deno.test('Sway cross: a new plain brace cannot cut through an existing arm or its flange', () => {
  const topo=post(), result=analyze(topo,45,ID), face=side(topo,-1,-60);
  const first=swayAtFace(topo,result,ID,face,[0,-60,400],{...opts,crossAbove:10});
  const next=swayAtFace(topo,result,ID,face,[40,-60,400],opts);
  assert(first.ok && next.ok && !swayClashes(next,[{...first,arms:[]}]), 'main plates are clear');
  assert(swayClashes(next,[first]), 'new main plate ignores the existing arm');
  assert(!swayAtFace(topo,result,ID,face,[40,-60,400],opts,[first]).ok,
    'disabling cross ribs bypasses collision with an existing arm');
  const [lo,hi]=[first.foot[0][1],first.foot[1][1]].sort((a,b)=>a-b);
  const y=first.arms[0].a[1]+prop.PROP.footMin+SWAY.clearance-0.1;
  const flange={...next,foot:[[20,y,0],[30,y,0]],halfW:0,levels:[{z:0,a:[20,y,0],b:[30,y,0]}]};
  assert(y>lo && y<hi);
  assert(swayClashes(flange,[first]), 'flange clearance was reduced to the thin rib thickness');
});

Deno.test('Sway cross: Auto cross-ribs braces at the page threshold and honours the off switch', () => {
  const topo=post(), result=analyze(topo,45,ID);
  const build=(extra)=>fins.buildFins(topo,result,ID,{mode:'auto',tines:true,layerHeight:0.6,...extra});
  const low=build({sway:{on:true,crossAbove:10}});
  const off=build({sway:{on:true,crossAbove:Infinity}});
  const denied=build({tallRibs:false,sway:{on:true,crossAbove:10}});
  assert(low.sway.count>=2,'no braces to check');
  assert(low.sway.cross===2*low.sway.count, `one pair per brace: ${low.sway.cross}`);
  assert(low.triangles.length>off.triangles.length,'the Auto mesh has no cross ribs');
  const sw=low.fins.filter((f)=>f.kind==='sway');
  assert(sw.length===low.sway.count,'brace records missing');
  for (const f of sw) assert(f.triRanges.length===1 && isClosed(low.triangles.slice(...f.triRanges[0])),
    'a cross rib falls outside its brace record');
  // the box unticked leaves the braces exactly as Auto built them before
  assert(denied.triangles.length===off.triangles.length,'the off switch kept the cross ribs');
  assert(denied.sway.cross===0,'the off switch built cross ribs');
  for (const f of off.fins.filter((r)=>r.kind==='sway')) {
    assert(isClosed(off.triangles.slice(...f.triRanges[0])), 'plain brace lost a piece');
  }
  assert(JSON.stringify(off.fins.filter((f)=>f.kind==='sway').map((f)=>f.height))===
    JSON.stringify(sw.map((f)=>f.height)), 'the cross ribs moved the braces');
});
