import React, {useMemo} from 'react';
import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {ThreeCanvas} from '@remotion/three';
import * as THREE from 'three';

// The film uses normal geometry and frame-derived transforms. It can be sought
// in either direction without simulation state, timers, or an animation loop.
const C = {bg:'#0b1424',ink:'#f2f5fa',muted:'#9eafc7',cyan:'#69e3d3',yellow:'#ffcf78',red:'#ff8c85'};
const palette = ['#69e3d3','#78b6ff','#bba2ff','#ffcf78','#f492ae','#7ed0fa','#a7dda2','#f7ae7b'];
const ease = (f:number,a:number,b:number,from=0,to=1) => interpolate(f,[a,b],[from,to],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.inOut(Easing.cubic)});
const point = (u:number,v:number) => new THREE.Vector3((2.1+.64*Math.cos(v))*Math.cos(u),(2.1+.64*Math.cos(v))*Math.sin(u),.64*Math.sin(v));
const patches = Array.from({length:32},(_,id)=>{
  const points:THREE.Vector3[]=[]; const normals:THREE.Vector3[]=[]; const centroids:THREE.Vector3[]=[];
  for(let i=0;i<4;i++)for(let j=0;j<4;j++){
    const u=(Math.floor(id/4)*4+i)/32*Math.PI*2,v=((id%4)*4+j)/16*Math.PI*2;
    const a=point(u,v),b=point(u+Math.PI/16,v),c=point(u+Math.PI/16,v+Math.PI/8),d=point(u,v+Math.PI/8);
    for(const tri of [[a,b,c],[a,c,d]]){
      points.push(...tri); normals.push(tri[1].clone().sub(tri[0]).cross(tri[2].clone().sub(tri[0])).normalize());
      centroids.push(tri[0].clone().add(tri[1]).add(tri[2]).multiplyScalar(1/3));
    }
  }
  const center=new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
  const radius=Math.max(...points.map(p=>p.distanceTo(center)));
  const axis=normals.reduce((s,n)=>s.add(n),new THREE.Vector3()).normalize();
  const halfAngle=Math.acos(Math.min(...normals.map(n=>n.dot(axis))));
  return {points,center,radius,axis,halfAngle,normals,centroids};
});
const selected=patches[0];
const orientation=new THREE.Quaternion().setFromUnitVectors(selected.axis,new THREE.Vector3(0,0,1));
const localPoint=(p:THREE.Vector3)=>p.clone().sub(selected.center).multiplyScalar(1.45/selected.radius).applyQuaternion(orientation);

function Geometry({points,wire=false,color=C.cyan,opacity=1}:{points:THREE.Vector3[];wire?:boolean;color?:string;opacity?:number}){
  const positions=useMemo(()=>new Float32Array(points.flatMap(p=>p.toArray())),[points]);
  return <mesh><bufferGeometry onUpdate={g=>g.computeVertexNormals()}><bufferAttribute attach="attributes-position" args={[positions,3]}/></bufferGeometry><meshStandardMaterial color={color} roughness={.48} metalness={.12} side={THREE.DoubleSide} transparent opacity={opacity} wireframe={wire} polygonOffset polygonOffsetFactor={wire?-1:0}/></mesh>;
}
function Segment({from,to,color=C.yellow}:{from:THREE.Vector3;to:THREE.Vector3;color?:string}){
  const positions=useMemo(()=>new Float32Array([...from.toArray(),...to.toArray()]),[from.x,from.y,from.z,to.x,to.y,to.z]);
  return <lineSegments><bufferGeometry><bufferAttribute attach="attributes-position" args={[positions,3]}/></bufferGeometry><lineBasicMaterial color={color}/></lineSegments>;
}
function NormalArrow({from,to}:{from:THREE.Vector3;to:THREE.Vector3}){
 const direction=to.clone().sub(from).normalize();
 const rotation=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),direction);
 return <><Segment from={from} to={to}/><mesh position={to.toArray()} quaternion={rotation}><coneGeometry args={[.045,.15,8]}/><meshBasicMaterial color={C.yellow}/></mesh></>;
}
function Stage({children}:{children:React.ReactNode}){
  return <ThreeCanvas width={1280} height={720} orthographic camera={{position:[0,0,12],zoom:78,near:.1,far:100}} style={{position:'absolute',inset:0}} gl={{alpha:true,antialias:true}}><ambientLight intensity={1.2}/><directionalLight position={[4,5,8]} intensity={2.5}/><directionalLight position={[-4,-3,2]} intensity={.8}/>{children}</ThreeCanvas>;
}
function Title({number,children}:{number:string;children:React.ReactNode}){
 return <div style={{position:'absolute',left:64,top:46}}><div style={{color:C.cyan,fontSize:17,letterSpacing:3,marginBottom:14}}>MESHLETS / {number}</div><div style={{fontSize:45,fontWeight:700,letterSpacing:-1.5}}>{children}</div></div>;
}
function Caption({children,accent=C.ink}:{children:React.ReactNode;accent?:string}){
 return <div style={{position:'absolute',bottom:48,left:64,right:64,fontSize:29,fontWeight:500,color:accent}}>{children}</div>;
}
function Tag({x,y,children,color=C.cyan}:{x:number;y:number;children:React.ReactNode;color?:string}){
 return <div style={{position:'absolute',left:x,top:y,borderLeft:`3px solid ${color}`,padding:'8px 15px',fontSize:23,color,background:'#0b1424dd'}}>{children}</div>;
}
function TorusShot({f}:{f:number}){
 const split=ease(f,200,290,0,.26),wire=ease(f,80,125),colors=ease(f,160,210);
 return <><Title number="01">A mesh becomes small groups</Title><Stage><group position={[1.3,-.2,0]} rotation={[.35,ease(f,0,330,-.5,.2),.12]}>
 {patches.map((p,i)=><group key={i} position={p.center.clone().multiplyScalar(split).toArray()}><Geometry points={p.points} color={new THREE.Color('#7795b8').lerp(new THREE.Color(palette[i%8]),colors).getStyle()}/><Geometry points={p.points} wire color="#12263c" opacity={wire*.7}/></group>)}
 </group></Stage>
 <div style={{position:'absolute',left:64,top:265,fontSize:70,fontWeight:700,letterSpacing:-3}}>{f<180?'1,024':'32'}<div style={{fontSize:24,color:C.muted,letterSpacing:0,marginTop:8}}>{f<180?'triangles':'meshlets'}</div></div>
 {f>=220&&<Tag x={920} y={440}>32 triangles / group</Tag>}
 <Caption>{f<100?'Start with one continuous surface.':f<190?'Its surface is made of triangles.':'Group nearby triangles. Test each group together.'}</Caption></>;
}
function BoundShot({f}:{f:number}){
 const points=useMemo(()=>selected.points.map(localPoint),[]); const sphere=ease(f,80,140);
 return <><Title number="02">One cheap test for a whole group</Title><Stage><group position={[.5,-.15,0]} rotation={[.15,ease(f,0,240,-.3,.25),-.2]} scale={1.45}><Geometry points={points}/><Geometry points={points} wire color="#153c45"/>
 <mesh><sphereGeometry args={[1.45,32,20]}/><meshBasicMaterial color={C.yellow} wireframe transparent opacity={sphere*.2}/></mesh></group></Stage>
 <svg width="1280" height="720" style={{position:'absolute',inset:0,opacity:sphere}}><path d="M 801 279 L 915 230 L 1100 230" stroke={C.yellow} fill="none" strokeWidth="2"/><circle cx="801" cy="279" r="5" fill={C.yellow}/></svg>
 <Tag x={908} y={180} color={C.yellow}>Bounding sphere</Tag><Tag x={120} y={430}>32 triangles</Tag>
 <Caption>A sphere encloses every vertex in this meshlet.</Caption></>;
}
// One side-plane of an orthographic view, seen from above. Positive signed
// distance is inside. Reject only when d < -r; overlap must remain accepted.
function FrustumShot({f}:{f:number}){
 const x=f<210?ease(f,45,135,540,835):ease(f,220,310,835,1030);
 const radius=94,plane=810,d=plane-x,rejected=d < -radius;
 const vanish=ease(f,330,365,1,.2);
 return <><Title number="03">Outside the view?</Title>
 <svg width="1280" height="720" style={{position:'absolute',inset:0}}>
 <defs><pattern id="outside-hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><line x1="0" y1="0" x2="0" y2="12" stroke="#233146" strokeWidth="3"/></pattern></defs>
 <rect x="310" y="235" width="500" height="320" rx="4" fill="#69e3d30c" stroke="#69e3d344"/>
 <rect x="810" y="235" width="350" height="320" fill="url(#outside-hatch)"/>
 <line x1={plane} x2={plane} y1="210" y2="575" stroke={C.ink} strokeWidth="3"/>
 <text x="330" y="270" fill={C.muted} fontSize="18">INSIDE THE VIEW</text><text x="965" y="270" fill={C.muted} fontSize="18">OUTSIDE</text>
 <path d="M 190 360 L 235 385 L 235 415 L 190 440 Z" fill={C.muted}/><rect x="145" y="365" width="45" height="70" rx="6" fill={C.muted}/>
 <path d="M 240 400 L 310 400" stroke={C.muted} strokeWidth="2" strokeDasharray="7 7"/>
 <text x="130" y="480" fill={C.muted} fontSize="20">Camera</text>
 <g opacity={vanish}><circle cx={x} cy="400" r={radius} fill={rejected?'#ff8c8514':'#69e3d316'} stroke={rejected?C.red:C.yellow} strokeWidth="3"/>
 {Array.from({length:4},(_,i)=>Array.from({length:4},(_,j)=>{const xx=x-52+i*26,yy=348+j*26;return <g key={`${i}-${j}`}><path d={`M${xx} ${yy}h26v26Z M${xx} ${yy}v26h26Z`} fill={rejected?'#604352':C.cyan} stroke={C.bg} strokeWidth="1.5"/></g>}))}
 <circle cx={x} cy="400" r="4" fill={C.ink}/><line x1={x} y1="400" x2={x-radius} y2="400" stroke={C.yellow} strokeWidth="2"/>
 </g>
 <text x="810" y="610" textAnchor="middle" fill={C.muted} fontSize="20">One of the view’s six planes · top view</text>
 </svg>
 <Tag x={x-65} y={180} color={rejected?C.red:C.cyan}>{rejected?'Reject group':'Keep group'}</Tag>
 <Caption accent={rejected?C.red:C.ink}>{f<140?'Move the meshlet toward the edge of the view.':rejected?'The entire sphere is outside. Skip this meshlet.':'Part of the sphere still overlaps. Keep the meshlet.'}</Caption></>;
}
function NormalsShot({f}:{f:number}){
 const points=useMemo(()=>selected.points.map(localPoint),[]);
 const angle=ease(f,130,270,-.6,Math.PI-.6),show=ease(f,25,80),axisZ=Math.cos(angle);
 // Orthographic cone rejection: every normal is backfacing when
 // -axis.z > sin(halfAngle). Wide cones cannot be conservatively rejected.
 const rejected=-axisZ>Math.sin(selected.halfAngle)+1e-7;
 const coneRadius=Math.tan(selected.halfAngle)*1.6;
 return <><Title number="04">Facing away from the camera?</Title><Stage><group position={[.5,-.25,0]} rotation={[0,angle,0]}>
 <Geometry points={points} color={rejected?C.red:C.cyan}/><Geometry points={points} wire color="#173443"/>
 {selected.normals.map((n,i)=>i%4===0&&<NormalArrow key={i} from={localPoint(selected.centroids[i])} to={localPoint(selected.centroids[i]).add(n.clone().applyQuaternion(orientation).multiplyScalar(show*.9))}/>)}
 <group position={[0,0,.8]} rotation={[-Math.PI/2,0,0]}><mesh><coneGeometry args={[coneRadius,1.6,40,1,true]}/><meshBasicMaterial color={C.yellow} transparent opacity={show*.15} side={THREE.DoubleSide}/></mesh></group>
 <Segment from={new THREE.Vector3()} to={new THREE.Vector3(0,0,2.3)} color={C.yellow}/>
 </group></Stage>
 <Tag x={880} y={250} color={C.yellow}>Normal cone</Tag><Tag x={105} y={450} color={rejected?C.red:C.cyan}>{rejected?'All faces point away':'Keep group'}</Tag>
 <div style={{position:'absolute',right:74,bottom:115,color:C.muted,fontSize:18}}>Camera faces into the screen · orthographic view</div>
 <Caption>{f<100?'Face normals describe which way the triangles point.':f<200?'A cone bounds those directions. Now turn the group.':rejected?'The whole cone faces away. Skip the meshlet.':'Some faces may still face the camera. Keep the group.'}</Caption></>;
}
function RecapShot({f}:{f:number}){
 const at=ease(f,30,220,0,1);
 return <><Title number="05">Less geometry reaches the next stage</Title>
 <svg width="1280" height="720" style={{position:'absolute',inset:0}}>
 <line x1="170" y1="390" x2="1110" y2="390" stroke="#344359" strokeWidth="2"/>
 {[450,800].map((x,i)=><g key={x}><rect x={x-4} y="270" width="8" height="240" rx="4" fill={i?C.yellow:C.cyan}/><text x={x} y="240" fill={C.ink} fontSize="24" textAnchor="middle">{i?'Normal cone':'View bounds'}</text></g>)}
 {Array.from({length:8},(_,i)=>{
   const p=Math.max(0,Math.min(1,at*1.8-i*.1));const first=i===2||i===6,second=i===4||i===7;
   const stop=first?450:second?800:1100;const x=170+(stop-170)*p;const down=(first||second)&&p>.92?(p-.92)/.08*140:0;
   return <g key={i} transform={`translate(${x},${340+i%3*46+down})`} opacity={down?1-down/160:1}><path d="M-15 10 L0 -16 L15 10 Z" fill={palette[i]} stroke={C.bg} strokeWidth="2"/></g>;
 })}
 <text x="170" y="565" fill={C.muted} fontSize="22" textAnchor="middle">Meshlets</text><text x="450" y="565" fill={C.muted} fontSize="20" textAnchor="middle">Reject outside</text><text x="800" y="565" fill={C.muted} fontSize="20" textAnchor="middle">Reject backfacing</text><text x="1090" y="565" fill={C.cyan} fontSize="22" textAnchor="middle">Process survivors</text>
 </svg><Caption>Reject only when certain. A kept meshlet can still be hidden.</Caption></>;
}
export default function MeshletsFilm(){
 const f=useCurrentFrame();
 return <AbsoluteFill style={{background:C.bg,color:C.ink,fontFamily:'Arial, Helvetica, sans-serif',overflow:'hidden'}}>
 <AbsoluteFill style={{background:'radial-gradient(ellipse at 58% 48%, #21334a 0%, transparent 65%)'}}/>
 {f<360?<TorusShot f={f}/>:f<630?<BoundShot f={f-360}/>:f<1080?<FrustumShot f={f-630}/>:f<1500?<NormalsShot f={f-1080}/>:<RecapShot f={f-1500}/>}
 <div style={{position:'absolute',bottom:0,left:0,height:3,width:`${f/1799*100}%`,background:C.cyan}}/>
 </AbsoluteFill>;
}
