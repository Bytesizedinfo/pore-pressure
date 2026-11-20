'use strict';
/* GLSL sources. World units: mm. Camera is orthographic, looking down -z at the skin (z toward the lens). */
PP.SH = {};

PP.SH.fsVS = `
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

PP.SH.common = `
uniform vec2 uCam; uniform vec2 uView; uniform vec2 uRes; uniform float uPatch; uniform vec2 uVSc;
// screen-space render targets are only partly used under dynamic resolution
vec4 texS(sampler2D t, vec2 uv){ return texture(t, clamp(uv, vec2(0.0), vec2(1.0) - 0.5/uRes) * uVSc); }
vec2 worldOf(vec2 uv){ return uCam + (uv-0.5)*uView; }
vec2 uvOf(vec2 w){ return (w-uCam)/uView + 0.5; }
vec2 patchUv(vec2 w){ return w/uPatch + 0.5; }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(.1031,.1030,.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<4;i++){ s+=a*vnoise(p); p=p*2.03+vec2(17.1,9.3); a*=0.5; } return s; }
`;

/* ---------- elastic deformation field (half resolution) ---------- */
PP.SH.defFS = PP.SH.common + `
in vec2 vUv;
layout(location=0) out vec4 o0;   // ux, uy, w, div
layout(location=1) out vec4 o1;   // principal compressive strain, dir.x, dir.y, stretch
uniform vec4 uC0[48]; uniform vec4 uC1[48]; uniform int uNC;
uniform float uNu, uEn, uG, uLd, uHeff;
uniform vec4 uCut0[16]; uniform vec4 uCut1[16]; uniform int uNCut;
uniform vec4 uHole0[8]; uniform vec4 uHole1[8]; uniform int uNH;
uniform vec2 uT;   // tension-line direction
uniform vec4 uInj[8]; uniform vec4 uInj2[8]; uniform int uNI;
uniform vec4 uPinch0, uPinch1;   // pinch fold: midpoint, axis | span, height, pad width, on
float foldW(vec2 p){
  if(uPinch1.w<0.5) return 0.0;
  vec2 d=p-uPinch0.xy; float s=dot(d,uPinch0.zw), q=dot(d,vec2(-uPinch0.w,uPinch0.z));
  if(abs(s)>=uPinch1.x*0.5) return 0.0;
  float c=cos(3.14159265*s/uPinch1.x);
  return uPinch1.y*c*c*exp(-(q*q)/(0.3*uPinch1.z*uPinch1.z));
}
float dentW(float fn, float a, float r){
  float w0 = 2.0*(1.0-uNu*uNu)*fn/(3.14159265*a*uEn);
  float p = r/a;
  float f = p<1.0 ? 1.0-(1.0-0.63662)*p*p : 1.0/(2.0*p) + (0.63662-0.5)/(p*p*p);
  return -w0*f*exp(-r/uLd);
}
vec2 cerruti(vec2 q, float a, vec2 d){
  float r2 = dot(d,d)+a*a; float r = sqrt(r2);
  float k = 1.0/(6.2831853*uG*r);
  float qr = dot(q,d)/r2;
  return k*((1.0-uNu)*q + uNu*qr*d)*exp(-length(d)/uLd);
}
vec3 field(vec2 p){
  vec2 u = vec2(0.0); float w = 0.0;
  for(int i=0;i<uNC;i++){
    vec4 c0=uC0[i], c1=uC1[i];
    vec2 d = p-c0.xy; float r = length(d);
    if(c0.w>0.0){
      w += dentW(c0.w, c0.z, r);
      // soft pads: displaced, nearly incompressible tissue rises in a low rim around the pad
      if(c1.w>0.5) w -= 0.12*dentW(c0.w, c0.z, 0.0)*exp(-pow((r-1.25*c0.z)/(0.45*c0.z),2.0));
    }
    if(c1.z>0.0) w -= 0.5*dentW(c1.z*1e-3*3.14159265*c0.z*c0.z, c0.z, r);
    if(abs(c1.x)+abs(c1.y)>0.0) u += cerruti(c1.xy, c0.z, d);
  }
  // incisions: lips pulled apart by prestress (Griffith crack opening), decaying away from the cut
  for(int i=0;i<uNCut;i++){
    vec4 a=uCut0[i], b=uCut1[i];
    vec2 ab=a.zw-a.xy; float L=length(ab); if(L<1e-3) continue;
    vec2 t=ab/L, n=vec2(-t.y,t.x);
    vec2 d=p-a.xy; float s=dot(d,t)-L*0.5, h=dot(d,n);
    float hl=L*0.5;
    float g=0.5*b.y*sqrt(max(0.0,1.0-(s*s)/(hl*hl+1e-4)));
    float side = h>=0.0?1.0:-1.0;
    float fall = exp(-abs(h)/(0.45*hl+0.3)) * (1.0-smoothstep(hl, hl*1.6, abs(s)));
    u += n*side*g*fall;
  }
  // punch holes: Kirsch-like outward radial displacement, oval along the tension lines
  for(int i=0;i<uNH;i++){
    vec4 h0=uHole0[i];
    vec2 d=p-h0.xy; float r=length(d)+1e-4;
    vec2 tl=vec2(dot(d,uT), dot(d,vec2(-uT.y,uT.x)));
    float th=atan(tl.y,tl.x);
    float ra = mix(h0.z, h0.w, 0.5-0.5*cos(2.0*th));   // along -> across
    float a0 = 2.0;
    float ur = (ra-a0)*(a0*a0)/(max(r,a0)*max(r,a0));
    u += d/r*ur;
  }
  // injection wheals: infiltrated volume lifts the skin
  for(int i=0;i<uNI;i++){
    vec4 j=uInj[i]; float r=length(p-j.xy);
    w += uInj2[i].x * exp(-(r*r)/(j.z*j.z*0.35));
  }
  return vec3(u,w);
}
void main(){
  vec2 p = worldOf(vUv);
  float h = 0.15;
  vec3 f0 = field(p), fx = field(p+vec2(h,0.0)), fy = field(p+vec2(0.0,h));
  float exx=(fx.x-f0.x)/h, eyy=(fy.y-f0.y)/h, exy=0.5*((fx.y-f0.y)/h+(fy.x-f0.x)/h);
  float div = exx+eyy;
  float th = -uHeff*div;
  // the pinch fold takes over where it rises above the small-strain thickening
  float fold = foldW(p);
  float w = f0.z + th + max(0.0, fold - max(0.0, th));
  float tr = 0.5*(exx+eyy), dd = sqrt(0.25*(exx-eyy)*(exx-eyy)+exy*exy);
  float lmin = tr-dd, lmax = tr+dd;
  vec2 dir = abs(exy)>1e-6 ? normalize(vec2(lmin-eyy, exy)) : (exx<eyy?vec2(1,0):vec2(0,1));
  o0 = vec4(f0.xy, w, div);
  // the fold crest is bent over a short span: its surface is stretched (pales, smooths, shines)
  o1 = vec4(lmin, dir, max(lmax,0.0) + 0.3*fold/max(uPinch1.x,1.0));
}`;

/* ---------- precompute micro-relief gradient from height maps ---------- */
PP.SH.gradFS = `
in vec2 vUv; out vec4 o; uniform sampler2D uH; uniform float uSize;
void main(){
  float e=1.0/uSize;
  float hl=texture(uH,vUv-vec2(e,0)).r, hr=texture(uH,vUv+vec2(e,0)).r;
  float hd=texture(uH,vUv-vec2(0,e)).r, hu=texture(uH,vUv+vec2(0,e)).r;
  vec4 c=texture(uH,vUv);
  o=vec4((hr-hl)*uSize*0.5, (hu-hd)*uSize*0.5, c.r, c.g);
}`;

/* ---------- GGX prefilter of the equirect HDRI into an atlas (5 roughness levels) ---------- */
PP.SH.prefFS = `
in vec2 vUv; out vec4 o; uniform sampler2D uEnv; uniform float uRough;
vec3 dirOf(vec2 uv){ float th=uv.y*3.14159265, ph=uv.x*6.2831853; return vec3(sin(th)*sin(ph), cos(th), -sin(th)*cos(ph)); }
vec2 uvOfDir(vec3 d){ float th=acos(clamp(d.y,-1.0,1.0)); float ph=atan(d.x,-d.z); if(ph<0.0) ph+=6.2831853; return vec2(ph/6.2831853, th/3.14159265); }
float rad(uint b){ b=(b<<16u)|(b>>16u); b=((b&0x55555555u)<<1u)|((b&0xAAAAAAAAu)>>1u); b=((b&0x33333333u)<<2u)|((b&0xCCCCCCCCu)>>2u); b=((b&0x0F0F0F0Fu)<<4u)|((b&0xF0F0F0F0u)>>4u); b=((b&0x00FF00FFu)<<8u)|((b&0xFF00FF00u)>>8u); return float(b)*2.3283064365386963e-10; }
void main(){
  vec3 N=dirOf(vUv); vec3 up=abs(N.y)<0.999?vec3(0,1,0):vec3(1,0,0);
  vec3 T=normalize(cross(up,N)), B=cross(N,T);
  float a=uRough*uRough; vec3 acc=vec3(0); float wsum=0.0;
  for(uint i=0u;i<192u;i++){
    vec2 xi=vec2(float(i)/192.0, rad(i));
    float ph=6.2831853*xi.x; float ct=sqrt((1.0-xi.y)/(1.0+(a*a-1.0)*xi.y)); float st=sqrt(1.0-ct*ct);
    vec3 H=T*(st*cos(ph))+B*(st*sin(ph))+N*ct;
    vec3 L=normalize(2.0*dot(N,H)*H-N);
    float nl=dot(N,L); if(nl>0.0){ acc+=min(textureLod(uEnv,uvOfDir(L),0.0).rgb, vec3(60.0))*nl; wsum+=nl; }
  }
  o=vec4(acc/max(wsum,1e-4),1.0);
}`;

/* ---------- object pass: particles + instruments ray-traced from above ---------- */
PP.SH.objVS = PP.SH.common + `
layout(location=0) in vec2 aQ;
layout(location=1) in vec4 iA; layout(location=2) in vec4 iB; layout(location=3) in vec4 iP; layout(location=4) in vec4 iC;
out vec2 vW; flat out vec4 fA; flat out vec4 fB; flat out vec4 fP; flat out vec4 fC;
void main(){
  fA=iA; fB=iB; fP=iP; fC=iC;
  vec2 lo, hi; int ty=int(iP.x+0.5);
  if(ty==2){ float e=max(iB.x,iB.y)*1.45; lo=iA.xy-e; hi=iA.xy+e; }
  else if(ty==3){ lo=min(min(iA.xy,iB.xy),iP.zw)-0.3; hi=max(max(iA.xy,iB.xy),iP.zw)+0.3; }
  else { lo=min(iA.xy-iA.w, iB.xy-iB.w); hi=max(iA.xy+iA.w, iB.xy+iB.w); }
  vec2 w = mix(lo, hi, aQ*0.5+0.5);
  vW = w;
  gl_Position = vec4((uvOf(w)*2.0-1.0), 0.0, 1.0);
}`;
PP.SH.objFS = PP.SH.common + `
in vec2 vW; flat in vec4 fA; flat in vec4 fB; flat in vec4 fP; flat in vec4 fC;
layout(location=0) out vec4 o0;   // height, material, nx, ny
layout(location=1) out vec4 o1;   // colour, alpha/aux
const float ZT = 300.0;
vec4 iRoundCone(vec3 ro, vec3 rd, vec3 pa, vec3 pb, float ra, float rb){
  vec3 ba=pb-pa, oa=ro-pa, ob=ro-pb; float rr=ra-rb;
  float m0=dot(ba,ba), m1=dot(ba,oa), m2=dot(ba,rd), m3=dot(rd,oa), m5=dot(oa,oa), m6=dot(ob,rd), m7=dot(ob,ob);
  float d2=m0-rr*rr; float k2=d2-m2*m2; float k1=d2*m3-m1*m2+m2*rr*ra; float k0=d2*m5-m1*m1+m1*rr*ra*2.0-m0*ra*ra;
  float h=k1*k1-k0*k2;
  if(h>=0.0 && abs(k2)>1e-9){ float t=(-sqrt(h)-k1)/k2; float y=m1-ra*rr+t*m2;
    if(y>0.0 && y<d2) return vec4(t, normalize(d2*(oa+t*rd)-ba*y)); }
  float h1=m3*m3-m5+ra*ra, h2=m6*m6-m7+rb*rb;
  vec4 r=vec4(1e20);
  if(h1>0.0){ float t=-m3-sqrt(h1); r=vec4(t,(oa+t*rd)/ra); }
  if(h2>0.0){ float t=-m6-sqrt(h2); if(t<r.x) r=vec4(t,(ob+t*rd)/rb); }
  return r;
}
void main(){
  vec3 ro=vec3(vW, ZT), rd=vec3(0,0,-1);
  int ty=int(fP.x+0.5); float mat=fP.y;
  float hgt=-1e9; vec3 n=vec3(0,0,1); vec4 col=fC;
  if(ty==0){ vec2 d=vW-fA.xy; float q=fA.w*fA.w-dot(d,d); if(q<0.0) discard; float hz=sqrt(q); hgt=fA.z+hz; n=normalize(vec3(d,hz)); }
  else if(ty==1){ vec4 r=iRoundCone(ro,rd,fA.xyz,fB.xyz,fA.w,fB.w); if(r.x>1e19) discard; hgt=ZT-r.x; n=r.yzw; if(n.z<0.0) n=-n; }
  else if(ty==2){ // slab: centre fA.xyz, half extents fB.xyz, angle fB.w
    vec2 d=vW-fA.xy; float c=cos(fB.w), s=sin(fB.w); vec2 l=vec2(c*d.x+s*d.y, -s*d.x+c*d.y);
    vec2 e=abs(l)-fB.xy; float out_=max(e.x,e.y); if(out_>0.0) discard;
    float bev=min(1.0, -out_/max(fB.z*1.5,0.3)); float hh=fB.z*(0.35+0.65*sqrt(bev));
    hgt=fA.z+hh; float g = (1.0-bev)*0.9; vec2 gd = e.x>e.y? vec2(sign(l.x),0.0):vec2(0.0,sign(l.y)); gd=vec2(c*gd.x-s*gd.y, s*gd.x+c*gd.y);
    n=normalize(vec3(gd*g,1.0));
  } else { // blade: triangle tip fA.xyz, heel fB.xyz, spine (fP.zw, fC.x)
    vec3 A=fA.xyz, B=fB.xyz, C=vec3(fP.zw, fC.x);
    vec3 N=normalize(cross(B-A,C-A)); if(N.z<0.0) N=-N; if(abs(N.z)<1e-3) discard;
    float t=dot(A-ro,N)/dot(rd,N); vec3 P=ro+rd*t;
    vec3 v0=B-A, v1=C-A, v2=P-A; float d00=dot(v0,v0), d01=dot(v0,v1), d11=dot(v1,v1), d20=dot(v2,v0), d21=dot(v2,v1);
    float den=d00*d11-d01*d01; float bv=(d11*d20-d01*d21)/den, bw=(d00*d21-d01*d20)/den;
    if(bv<0.0||bw<0.0||bv+bw>1.0) discard;
    hgt=P.z+0.05; n=N; col=vec4(0.86,0.86,0.88,0.0);
  }
  o0=vec4(hgt, mat, n.x, n.y);
  o1=vec4(col.rgb, col.a);
  gl_FragDepth = clamp(1.0 - (hgt+20.0)/320.0, 0.0, 1.0);
}`;

/* fluid smoothing: merge particle caps into blobs; keep analytic normals for solids/tools */
PP.SH.smoothFS = PP.SH.common + `
in vec2 vUv; layout(location=0) out vec4 o0; uniform sampler2D uObj; uniform float uPxMm;
bool isFluid(float m){ return m>0.5 && m<16.5 && abs(m-10.0)>0.5 && abs(m-12.0)>0.5 && abs(m-8.0)>0.5; }
void main(){
  vec4 c=texS(uObj, vUv);
  if(!isFluid(c.y)){ o0=c; return; }
  vec2 px=1.0/uRes; float r=clamp(uPxMm*0.08,1.0,3.0);
  float s=0.0, w=0.0;
  for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){
    vec4 q=texS(uObj, vUv+vec2(i,j)*px*r);
    float k = exp(-float(i*i+j*j)*0.35);
    if(isFluid(q.y)){ s+=q.x*k; w+=k; } else { s+=(c.x-0.08)*k; w+=k; }
  }
  float h=s/w;
  float hx=texS(uObj, vUv+vec2(px.x*r,0)).x, hy=texS(uObj, vUv+vec2(0,px.y*r)).x;
  float hxm=texS(uObj, vUv-vec2(px.x*r,0)).x, hym=texS(uObj, vUv-vec2(0,px.y*r)).x;
  vec2 g=vec2(hx-hxm, hy-hym)/(2.0*r/uPxMm);
  g = clamp(g, -6.0, 6.0);
  vec3 n=normalize(vec3(-g*0.7 + c.zw*0.3*vec2(1.0), 1.0));
  o0=vec4(max(h, c.x-0.05), c.y, n.x, n.y);
}`;

/* ---------- physiology field (world space, ping-pong): perfusion, hyperaemia debt, irritation, bruise ---------- */
PP.SH.physFS = PP.SH.common + `
in vec2 vUv; out vec4 o; uniform sampler2D uPrev; uniform float uDt;
uniform vec4 uC0[48]; uniform vec4 uC1[48]; uniform int uNC;
uniform vec4 uInj[8]; uniform vec4 uInj2[8]; uniform int uNI;
void main(){
  vec2 p=(vUv-0.5)*uPatch; vec4 s=texture(uPrev,vUv);
  float pr=0.0, su=0.0;
  for(int i=0;i<uNC;i++){ vec4 c=uC0[i]; float r=length(p-c.xy);
    float disc=1.0-smoothstep(c.z*0.8,c.z*1.15,r);
    if(c.w>0.0) pr += c.w/(3.14159*c.z*c.z)*1000.0*disc;
    su += uC1[i].z*disc; }
  float epi=0.0; for(int i=0;i<uNI;i++){ float r=length(p-uInj[i].xy); epi=max(epi, uInj[i].w*(1.0-smoothstep(uInj[i].z*0.5,uInj[i].z,r))); }
  // capillary blanching under pressure (~10 kPa empties the superficial plexus); suction congests
  float target = clamp(1.0 - pr/10.0, 0.12, 1.0)*(1.0-0.65*epi) + su/65.0*0.9;
  float v=s.r;
  float tau = target<v ? 0.12 : 0.7;
  // reactive hyperaemia only once the pressure is off (not while still compressed)
  float hyper = 0.45*s.g*(1.0 - smoothstep(2.0, 8.0, pr));
  v += (target + hyper - v)*(1.0-exp(-uDt/tau));
  float debt = s.g + uDt*(max(0.0,1.0-v)*0.3) ; debt *= exp(-uDt/75.0);
  float irr = s.b + uDt*(max(0.0,pr-12.0)/2400.0 + su/4000.0); irr *= exp(-uDt/(6.0*3600.0)); irr=min(irr,0.8);
  float br = s.a + uDt*max(0.0, su-33.0)/22.0*step(0.0,su-1.0)*0.35; br *= exp(-uDt/(5.0*86400.0)); br=min(br,1.5);
  o=vec4(v, min(debt,1.0), irr, br);
}`;

/* brush painting into world-space decal textures */
PP.SH.brushVS = PP.SH.common + `
layout(location=0) in vec2 aQ; layout(location=1) in vec4 iA; layout(location=2) in vec4 iB;
out vec2 vL; flat out vec4 fB;
void main(){ fB=iB; vL=aQ; vec2 w=iA.xy+aQ*iA.z; gl_Position=vec4(patchUv(w)*2.0-1.0,0.0,1.0); }`;
PP.SH.brushFS = `
in vec2 vL; flat in vec4 fB; out vec4 o;
void main(){ float r=length(vL); if(r>1.0) discard; float k=(1.0-smoothstep(0.35,1.0,r)); o=fB*k; }`;

/* ---------- skin shading (full resolution, MRT) ---------- */
PP.SH.skinFS = PP.SH.common + `
in vec2 vUv;
layout(location=0) out vec4 oIrr;    // diffuse irradiance (rgb), skin mask
layout(location=1) out vec4 oAlb;    // albedo (rgb), height (for DoF)
layout(location=2) out vec4 oSpec;   // specular + opaque object colour
uniform sampler2D uChromo, uNrm, uDet, uDef0, uDef1, uObj, uObjCol, uPhys, uFilm, uMarks, uEnvP, uHeat, uLes, uDetail;
uniform highp usampler2D uLGrid; uniform int uGridN; uniform int uLSlots;
uniform float uTile, uHmm, uDetTile, uDetAmt, uPxMm, uTime, uOil, uRedBase, uHair;
uniform vec3 uTone;   // melanin, hemoglobin, shade means
uniform vec3 uToneA;  // variation amplitudes
uniform vec3 uVM, uVH, uVS;
uniform vec3 uSH[9]; uniform float uYaw, uExposure, uRing; uniform vec3 uKey;
uniform vec4 uCut0[16]; uniform vec4 uCut1[16]; uniform int uNCut;
uniform vec4 uHole0[8]; uniform vec4 uHole1[8]; uniform int uNH;
uniform vec4 uPun[32]; uniform int uNP;
uniform vec2 uT; uniform float uDermis, uEpi;
uniform vec4 uPatchD[8]; uniform int uNPatch;
uniform float uBloodOn;
uniform int uDbg;
uniform int uHasObj;
uniform float uDetK;

vec3 shEval(vec3 n){
  float x=n.x,y=n.y,z=n.z;
  vec3 r = 0.886227*uSH[0] + 1.023328*(uSH[1]*y + uSH[2]*z + uSH[3]*x)
    + 0.858086*(uSH[4]*x*y + uSH[5]*y*z + uSH[7]*x*z) + 0.247708*uSH[6]*(3.0*z*z-1.0) + 0.429043*uSH[8]*(x*x-y*y);
  return max(r, vec3(0.0));
}
vec3 toEnv(vec3 v){ float c=cos(uYaw), s=sin(uYaw); return vec3(c*v.x+s*v.z, v.y, -s*v.x+c*v.z); }
vec2 envUv(vec3 d){ float th=acos(clamp(d.y,-1.0,1.0)); float ph=atan(d.x,-d.z); if(ph<0.0) ph+=6.2831853; return vec2(ph/6.2831853, th/3.14159265); }
vec3 envSpec(vec3 R, float rough){
  float lv = clamp((rough-0.04)/0.7,0.0,1.0)*4.0; float l0=floor(lv); float f=lv-l0;
  vec2 uv=envUv(toEnv(R)); uv.y = clamp(uv.y, 0.01, 0.99);
  vec3 a=texture(uEnvP, vec2(uv.x, (uv.y+l0)/5.0)).rgb, b=texture(uEnvP, vec2(uv.x,(uv.y+min(l0+1.0,4.0))/5.0)).rgb;
  vec3 c=mix(a,b,f);
  // clinic ring light around the lens axis (wet surfaces show the ring catchlight)
  float ang = acos(clamp(R.z,-1.0,1.0));
  float w = 0.035+rough*0.9;
  c += uRing * 22.0 * exp(-pow((ang-0.20)/w,2.0)) * (0.06/(w+0.03));
  return c;
}
// direct specular from the key softbox (GGX, Schlick, simplified visibility)
vec3 keySpec(vec3 N, vec3 L, float rough, float f0){
  vec3 V=vec3(0,0,1); vec3 H=normalize(L+V);
  float nh=max(dot(N,H),0.0), nl=max(dot(N,L),0.0), nv=max(N.z,1e-3), vh=max(dot(V,H),0.0);
  float a=max(rough*rough,0.002); float d=nh*nh*(a*a-1.0)+1.0; float D=a*a/(3.14159*d*d);
  float F=f0+(1.0-f0)*pow(1.0-vh,5.0);
  float k=a*0.5; float G=(nl/(nl*(1.0-k)+k))*(nv/(nv*(1.0-k)+k));
  return vec3(1.0,0.98,0.95)*D*F*G/(4.0*nv+1e-3);
}
// hex tiling (Mikkelsen 2022) without rotation; returns weights and per-cell offsets
void hexTile(vec2 st, out vec3 w, out vec2 o1, out vec2 o2, out vec2 o3){
  st *= 3.4641016;
  vec2 sk = vec2(st.x - 0.57735027*st.y, 1.15470054*st.y);
  vec2 b = floor(sk); vec3 t = vec3(fract(sk), 0.0); t.z = 1.0-t.x-t.y;
  float s = step(0.0,-t.z), s2 = 2.0*s-1.0;
  w = vec3(-t.z*s2, s-t.y*s2, s-t.x*s2);
  o1 = hash22(b+vec2(s,s)); o2 = hash22(b+vec2(s,1.0-s)); o3 = hash22(b+vec2(1.0-s,s));
  w = pow(max(w,0.0), vec3(6.0)); w /= dot(w,vec3(1.0));
}
vec4 hexSample(sampler2D T, vec2 uv, vec2 st){
  vec3 w; vec2 a,b,c; hexTile(st,w,a,b,c);
  vec2 dx=dFdx(uv), dy=dFdy(uv);
  return w.x*textureGrad(T,uv+a,dx,dy)+w.y*textureGrad(T,uv+b,dx,dy)+w.z*textureGrad(T,uv+c,dx,dy);
}
// hex sample of chromo + gradient with shared cells (coherent pigment/relief)
void hexPair(vec2 uv, vec2 st, out vec4 ch, out vec4 nr, out vec4 dt){
  vec3 w; vec2 a,b,c; hexTile(st,w,a,b,c);
  vec2 dx=dFdx(uv), dy=dFdy(uv);
  ch = w.x*textureGrad(uChromo,uv+a,dx,dy)+w.y*textureGrad(uChromo,uv+b,dx,dy)+w.z*textureGrad(uChromo,uv+c,dx,dy);
  nr = w.x*textureGrad(uNrm,uv+a,dx,dy)+w.y*textureGrad(uNrm,uv+b,dx,dy)+w.z*textureGrad(uNrm,uv+c,dx,dy);
  dt = w.x*textureGrad(uDetail,uv+a,dx,dy)+w.y*textureGrad(uDetail,uv+b,dx,dy)+w.z*textureGrad(uDetail,uv+c,dx,dy);
}

struct LO { float h; float hem; float deox; vec3 cCol; float cMix; float gloss; float wet; float stretch; float ao; };
vec4 LD(int i, int row){ return texelFetch(uLes, ivec2(row, i), 0); }
float domeP(float r, float R, float k){ float p=r/R; return p<1.0 ? pow(1.0-p*p, k) : 0.0; }

// lesion contribution at material point X; full=false -> height only
void lesion(int i, vec2 X, bool full, inout LO o){
  vec4 a=LD(i,0), b=LD(i,1);
  vec2 q=X-a.xy; float r=length(q), R=max(a.z,0.05), H=a.w;
  float ext = R*(b.x>14.5&&b.x<18.5 ? 1.25 : 2.4) + 1.0;
  if(r>ext) return;
  vec4 c=LD(i,2), d=LD(i,3), e=LD(i,4), f=LD(i,5);
  int vis=int(b.x+0.5); float infl=b.y, headR=b.z, openR=b.w;
  float deflate=d.y, crater=d.z, punct=d.w, seed=e.x, point=e.y, hema=e.z, ext2=e.w;
  float k = (vis==18)?1.0:(vis>=15&&vis<=17)?1.25:(vis==13||vis==9||vis==10||vis==11)?1.35:1.7;
  float dome = domeP(r,R,k) + (r<R?0.0:0.0);
  float h = H*dome;
  // pores and comedones are depressions
  if(vis==0||vis==5){ h -= (vis==0?0.05:0.02)*exp(-r*r/(openR*openR*1.6+1e-4)); }
  if(vis==3){ h -= 0.28*(1.0-smoothstep(openR*0.7, openR*1.35, r)); h += 0.05*exp(-pow((r-openR*1.45)/(openR*0.5),2.0)); }
  if(vis==14){ h -= H*0.45*exp(-r*r/(R*R*0.05)); }
  if(vis==20){ h -= H*0.35*exp(-r*r/(R*R*0.06)); }
  // opened / deflated: hole at the apex, loose wrinkled skin
  if(openR>0.0 && vis!=0 && vis!=3 && vis!=5 && vis!=4){ h -= min(0.25, openR*0.8)*exp(-r*r/(openR*openR*1.2)); }
  if(deflate>0.0){ float th=atan(q.y,q.x); h += deflate*H*0.12*sin(th*7.0+seed*20.0+r*6.0)*dome; }
  h -= crater*exp(-r*r/(R*R*0.25));
  o.h += h;
  if(!full) return;
  // inflammatory erythema extends beyond the dome
  float halo = exp(-r*r/(R*R*(2.2+infl*1.5)));
  o.hem += infl*0.75*halo;
  o.stretch = max(o.stretch, clamp(H/R*2.2,0.0,1.0)*dome);
  float tense = clamp(H/R*1.8,0.0,1.0)*dome*(1.0-deflate);
  o.gloss = max(o.gloss, tense);
  vec3 cc=c.rgb; float cm=0.0;
  if(vis==0){ float m=1.0-smoothstep(openR*0.75, openR*1.05, r); cm=m*(1.0-ext2); cc=mix(vec3(0.035,0.028,0.022),vec3(0.18,0.13,0.09),smoothstep(0.0,openR,r)); o.ao=min(o.ao,1.0-0.5*m*ext2); }
  else if(vis==5){ float m=1.0-smoothstep(openR*0.6, openR*1.2, r); cm=0.55*m*(1.0-ext2); cc=vec3(0.32,0.27,0.2); }
  else if(vis==3){ float m=1.0-smoothstep(openR*0.75, openR*1.0, r); cm=m*(1.0-ext2*0.85); cc=mix(vec3(0.05,0.045,0.04),vec3(0.2,0.18,0.15),vnoise(q*14.0)); o.ao=min(o.ao, 1.0-0.6*m); }
  else if(vis==4){ float m=1.0-smoothstep(0.12,0.22,r); cm=m*(1.0-ext2); cc=vec3(0.06,0.045,0.035);
    float th=atan(q.y,q.x); float sp=pow(abs(sin(th*4.5+seed*9.0)),40.0)*(1.0-smoothstep(0.2,0.55,r))*step(0.12,r); cm=max(cm,sp*0.8*(1.0-ext2)); }
  else if(vis==6){ float m=1.0-smoothstep(R*0.7,R*0.92,r); cm=0.88*m*(1.0-ext2); cc=vec3(0.96,0.95,0.92); o.gloss=max(o.gloss,0.8*m); }
  else if(vis==7||vis==8||vis==19){
    float m=1.0-smoothstep(headR*0.72, headR*1.02, r);
    float core=1.0-smoothstep(0.0, headR*0.8, r);
    cc = mix(c.rgb*vec3(1.02,1.0,0.94), c.rgb*vec3(1.05,0.97,0.78), core) * (0.92+0.16*vnoise(q*22.0+seed*40.0));
    cc = mix(cc, vec3(0.95,0.93,0.86), 0.25*(1.0-core));
    cm=(0.42+0.36*core)*m*(1.0-deflate*0.7)*c.a; }
  else if(vis==1||vis==2){ float m=1.0-smoothstep(headR*0.3, headR*1.1, r); cm=0.3*m*c.a; o.gloss=max(o.gloss,0.35*dome); }
  else if(vis==9||vis==10){
    float m=0.0;
    if(vis==9) m=1.0-smoothstep(headR*0.4, headR, r);
    else for(int k2=0;k2<3;k2++){ vec2 hp=vec2(cos(seed*40.0+float(k2)*2.1), sin(seed*40.0+float(k2)*2.1))*R*(0.18+0.12*float(k2)); m=max(m,1.0-smoothstep(headR*0.25,headR*0.6,length(q-hp))); }
    cm=0.85*m*point*(1.0-deflate*0.5)*c.a; o.deox += infl*0.25*halo;
  }
  else if(vis==11){ o.deox += 0.45*halo*infl; cm=0.25*dome*c.a; }
  else if(vis==13){ o.deox += 0.3*halo*infl; }
  else if(vis==14){ float th=atan(q.y,q.x); float lob=0.5+0.5*cos(th*6.0+seed*10.0); cm=0.5*dome*(0.55+0.45*lob)*smoothstep(R*0.12,R*0.3,r); cc=vec3(0.93,0.83,0.55);
    float tel = pow(abs(sin(th*5.0+seed*3.0+r*3.0)),60.0)*(1.0-smoothstep(R*0.5,R*1.3,r)); o.hem += tel*0.8; }
  else if(vis==15){ cm=0.12*dome*c.a; float pm=1.0-smoothstep(punct*0.6,punct*1.3,r); cc=mix(cc, vec3(0.06,0.05,0.04), pm); cm=max(cm, pm*0.9*(openR>0.3?0.0:1.0)); }
  else if(vis==17){ cm=0.38*dome*c.a; cc=vec3(0.96,0.82,0.45); }
  else if(vis==20){ cm=0.5*dome*(1.0-ext2); cc=vec3(0.95,0.93,0.88); o.gloss=max(o.gloss,0.6*dome); float core=1.0-smoothstep(R*0.12,R*0.3,r); cm=max(cm, 0.8*core*(1.0-ext2)); }
  if(vis==19 && ext2<0.5){ // terminal hair curled back under the skin: tapered partial arc, softened by the dermis above it
    float ang=seed*6.2831853; vec2 hq=vec2(cos(ang)*q.x+sin(ang)*q.y, -sin(ang)*q.x+cos(ang)*q.y);
    float arcR=R*0.48; vec2 hc=hq-vec2(arcR*0.35,0.0);
    float th=atan(hc.y,hc.x); float t=clamp((th+2.2)/4.4,0.0,1.0);
    float dd=abs(length(hc)-arcR*(1.0-0.25*t));
    float width=mix(0.045,0.018,t);
    float hm=(1.0-smoothstep(width*0.5, width*1.6, dd))*step(-2.2,th)*step(th,2.2);
    vec3 hairC=mix(vec3(0.16,0.12,0.11), vec3(0.32,0.27,0.27), 0.5+0.5*t);
    cc=mix(cc, hairC, hm); cm=max(cm, hm*mix(0.7,0.35,t));
  }
  if(openR>0.0 && vis!=0 && vis!=3 && vis!=5 && vis!=4){ float hole=1.0-smoothstep(openR*0.5, openR*1.1, r); cc=mix(cc, vec3(0.32,0.06,0.04), hole*0.7); cm=max(cm, hole*0.85); o.wet=max(o.wet,hole); }
  if(crater>0.0){ float cr=exp(-r*r/(R*R*0.18)); o.hem += crater*cr*1.5; o.wet=max(o.wet,cr*0.6); if(vis==9||vis==10){ cc=mix(cc,vec3(0.62,0.6,0.46),cr); cm=max(cm,cr*0.8);} }
  if(hema>0.0){ o.deox += hema*4.0*dome; }
  float scab=f.z; if(scab>0.0){ float sm=1.0-smoothstep(R*0.25,R*0.55,r+0.08*vnoise(q*9.0)); cc=mix(cc, vec3(0.28,0.1,0.05), sm*scab); cm=max(cm, sm*scab*0.95); }
  if(cm>o.cMix){ o.cCol=cc; } o.cMix=max(o.cMix,cm);
}

float objH(vec2 uv){ vec4 o=texS(uObj, uv); return o.y>0.5 ? o.x : -1e3; }

void main(){
  vec2 p = worldOf(vUv);
  vec4 d0 = texS(uDef0, vUv), d1 = texS(uDef1, vUv);
  vec2 X = p - d0.xy;
  float pxmm = uPxMm;
  // ---- lesions (looked up through a coarse grid)
  ivec2 gc = ivec2(clamp(patchUv(X), 0.0, 0.9999)*float(uGridN));
  uvec4 li = texelFetch(uLGrid, gc, 0);
  LO lo = LO(0.0,0.0,0.0,vec3(0.0),0.0,0.0,0.0,0.0,1.0);
  float hx=0.0, hy=0.0; float e=0.6/pxmm + 0.02;
  for(int s=0;s<uLSlots;s++){ uint id = li[s]; if(id==0u) continue;
    int i=int(id)-1;
    lesion(i, X, true, lo);
    LO t1=LO(0.0,0.0,0.0,vec3(0.0),0.0,0.0,0.0,0.0,1.0), t2=t1;
    lesion(i, X+vec2(e,0.0), false, t1); lesion(i, X+vec2(0.0,e), false, t2);
    hx += t1.h; hy += t2.h; }
  vec2 gL = vec2(hx-lo.h, hy-lo.h)/e;
  // ---- wounds
  float wd=0.0; float inW=0.0; float lip=0.0; float coreIn=0.0;
  for(int i=0;i<uNCut;i++){ vec4 a=uCut0[i], b=uCut1[i];
    vec2 ab=a.zw-a.xy; float L=length(ab); if(L<1e-3) continue; vec2 t=ab/L, n=vec2(-t.y,t.x);
    vec2 dd=p-a.xy; float s=dot(dd,t)-L*0.5, hh=dot(dd,n); float hl=L*0.5;
    float g = 0.5*b.y*sqrt(max(0.0,1.0-(s*s)/(hl*hl+1e-4)));
    float gv = max(g, 0.02 + 0.01*b.x);
    float inside = (1.0-smoothstep(gv*0.85, gv*1.05+0.012, abs(hh)))*(1.0-smoothstep(hl*0.97,hl+0.03,abs(s)));
    float prof = sqrt(max(0.0,1.0-pow(abs(hh)/max(gv,1e-3),2.0)))*sqrt(max(0.0,1.0-pow(abs(s)/hl,2.0)));
    if(inside>inW){ inW=inside; wd=b.x*prof; }
    lip = max(lip, exp(-pow((abs(hh)-gv)/0.06,2.0))*(1.0-smoothstep(hl*0.9,hl+0.1,abs(s))));
  }
  vec2 tl;
  for(int i=0;i<uNH;i++){ vec4 h0=uHole0[i], h1=uHole1[i];
    vec2 dd=p-h0.xy; tl=vec2(dot(dd,uT), dot(dd,vec2(-uT.y,uT.x)));
    float q=length(tl/vec2(h0.z,h0.w));
    float inside=1.0-smoothstep(0.96,1.02,q);
    if(h1.y>0.5){ // tissue core still in: just the circular cut line
      lip=max(lip, exp(-pow((q-1.0)/0.04,2.0))); }
    else if(inside>inW){ inW=inside; wd=h1.x*sqrt(max(0.0,1.0-q*q*0.6)); }
    lip=max(lip, exp(-pow((q-1.0)/0.05,2.0)));
  }
  float pun=0.0; for(int i=0;i<uNP;i++){ vec4 pp=uPun[i]; float r=length(p-pp.xy); pun=max(pun, 1.0-smoothstep(pp.z*0.5,pp.z,r)); }
  // ---- micro relief from the photo scan
  vec2 tuv = X/uTile;
  vec4 ch, nr, dtl; hexPair(tuv, tuv*1.15, ch, nr, dtl);
  vec4 dn = hexSample(uDet, X/uDetTile, X/uDetTile*1.3+31.7);
  float stretch = clamp(d1.w*6.0 + lo.stretch, 0.0, 1.0);
  float comp = clamp(-d1.x*5.0, 0.0, 1.0);
  float amp = (1.0-0.7*stretch)*(1.0+0.6*comp);
  vec2 gMicro = (nr.xy*uHmm/uTile + dn.xy*(uDetAmt*0.07)/uDetTile)*amp;
  // compression wrinkles (Cerda–Mahadevan): wavelength ~0.9 mm, amplitude lambda/pi*sqrt(excess strain)
  float ec = max(0.0, -d1.x-0.015);
  float lam = 0.9*(uDermis/1.2);
  vec2 kd = d1.yz; vec2 kt = vec2(-kd.y, kd.x);
  float brk = smoothstep(0.25, 0.75, vnoise(vec2(dot(X,kt)*0.9, dot(X,kd)*0.25) + 3.7));   // wrinkles break up along their length
  float A = lam/3.14159*sqrt(ec)*0.55*brk;
  float ph = dot(X,kd)*6.2831853/lam + 3.0*vnoise(X*0.45) + 4.0*(nr.z-0.5);
  vec2 gWr = A*cos(ph)*6.2831853/lam*kd;
  float wrH = A*sin(ph);
  // macro deformation gradient (half-res field)
  vec2 px = vec2(1.0)/uRes*2.0;
  float wxp=texS(uDef0, vUv+vec2(px.x,0)).z, wyp=texS(uDef0, vUv+vec2(0,px.y)).z;
  float wxm=texS(uDef0, vUv-vec2(px.x,0)).z, wym=texS(uDef0, vUv-vec2(0,px.y)).z;
  vec2 gDef = vec2(wxp-wxm, wyp-wym)/(2.0*px*uView);
  float H = d0.z + lo.h + wrH + (nr.z-0.5)*uHmm*amp - wd;
  vec2 grad = gDef + gL + gMicro + gWr;
  if(inW>0.0) grad = mix(grad, grad*0.3, inW);
  vec3 N = normalize(vec3(-grad, 1.0));
  // ---- chromophores -> albedo
  vec3 cn = (ch.rgb-0.5)*6.0;
  vec4 ph0 = texture(uPhys, patchUv(p));
  vec4 film = texture(uFilm, patchUv(p));
  vec4 mk = texture(uMarks, patchUv(p));
  float heat = texture(uHeat, patchUv(p)).r;
  float m = uTone.x + uToneA.x*cn.x + uTone.x*0.10*(fbm(X*0.045)-0.5);
  float perf = ph0.r;
  float hem = (uTone.y + uToneA.y*cn.y + uRedBase + 0.06*(fbm(X*0.07+7.0)-0.5)) * mix(0.42, 1.0, clamp(perf,0.0,1.6)) + 0.22*max(0.0,perf-1.0);
  // tension blanching: skin stretched over the fold crest or a tense dome is pressed thin and pales;
  // the compressed flanks pool a little blood
  hem *= 1.0 - 0.45*clamp(d1.w*6.0,0.0,1.0) - 0.15*lo.stretch;
  hem += 0.05*comp;
  hem += lo.hem + 0.22*ph0.b + 0.12*clamp((heat-33.0)/7.0,0.0,1.0) + 0.25*lip + 0.4*pun;
  float deox = lo.deox + ph0.a*0.6;
  float sh = uTone.z + uToneA.z*cn.z*0.6;
  vec3 OD = m*uVM + hem*uVH + sh*uVS + deox*vec3(0.62,0.68,0.42);
  vec3 alb = exp(-OD);
  // photographic micro-detail (multiplicative, from the de-lit scan); keep part of its chroma
  vec3 dr = dtl.rgb*2.0; float dl = dot(dr, vec3(0.2126,0.7152,0.0722));
  alb *= pow(clamp(mix(vec3(dl), dr, 0.4), 0.35, 1.28), vec3(uDetK));
  // pores and furrows: light is trapped in the pits and sebum/keratin sits in them (post-scatter darkening)
  float cav = clamp((0.55-nr.z)*2.2,0.0,1.0);
  alb *= mix(1.0, 0.72, clamp(nr.w*1.2,0.0,1.0)*(1.0-stretch)) * mix(1.0, 0.86, cav*(1.0-stretch));
  // petechiae: pinpoint haemorrhages from suction
  float pet = smoothstep(0.55,0.9, hash12(floor(p*7.0)))*smoothstep(0.15,0.6,ph0.a);
  alb = mix(alb, vec3(0.32,0.03,0.04), pet*0.7);
  // lesion contents showing through thin roofs
  alb = mix(alb, lo.cCol, lo.cMix);
  // wound walls: epidermis edge, pink-white dermis, yellow fat below the dermis
  if(inW>0.0){
    vec3 wc = wd < uEpi*1.5 ? vec3(0.75,0.45,0.4) : wd < uDermis ? mix(vec3(0.86,0.6,0.58), vec3(0.93,0.78,0.74), wd/uDermis) : vec3(0.95,0.8,0.32);
    wc = mix(wc, vec3(0.42,0.03,0.03), uBloodOn*clamp(0.55+0.4*(1.0-film.r*0.0),0.0,1.0)*smoothstep(0.1,0.6,wd));
    alb = mix(alb, wc, inW);
  }
  if(pun>0.0) alb = mix(alb, vec3(0.3,0.03,0.03)*uBloodOn + vec3(0.5,0.35,0.3)*(1.0-uBloodOn), pun*0.8);
  // iodine (brown povidone film)
  alb *= mix(vec3(1.0), vec3(0.62,0.33,0.12), clamp(film.a,0.0,1.0)*0.85);
  // pus residue + blood film (wet = glossy bright red, dry = dark brown)
  alb = mix(alb, vec3(0.86,0.78,0.5), clamp(film.g,0.0,1.0)*0.55);
  float wetness = clamp(film.b,0.0,1.0);
  vec3 bloodC = mix(vec3(0.16,0.03,0.02), vec3(0.42,0.02,0.02), wetness);
  alb = mix(alb, bloodC, clamp(film.r*1.2,0.0,0.92)*uBloodOn);
  // hydrocolloid patches
  float patchM=0.0; float patchAge=0.0;
  for(int i=0;i<uNPatch;i++){ float r=length(p-uPatchD[i].xy); float m2=1.0-smoothstep(uPatchD[i].z*0.92,uPatchD[i].z,r); if(m2>patchM){patchM=m2; patchAge=uPatchD[i].w;} }
  // stubble / vellus hair (beard, scalp)
  float hairM=0.0;
  if(uHair>0.5){
    vec2 cell=floor(X*(uHair>1.5?1.6:2.4)); vec2 fr=fract(X*(uHair>1.5?1.6:2.4))-0.5; vec2 jit=hash22(cell)-0.5;
    vec2 hq=fr-jit*0.5; float hr=length(hq);
    hairM=(1.0-smoothstep(0.035,0.06,hr))*(1.0-stretch);
    alb=mix(alb, vec3(0.05,0.04,0.035), hairM*0.85);
    alb=mix(alb, alb*vec3(0.75,0.78,0.85), (1.0-smoothstep(0.06,0.14,hr))*0.35);
  }
  // ---- lighting
  vec3 Ne = toEnv(N);
  vec3 Lk0 = normalize(uKey);
  float ndl = dot(N, Lk0);
  // soft studio fill (HDRI SH) + key strip light; wrap lets light bleed past the terminator as in skin
  vec3 fill = 0.42*shEval(Ne)*uExposure;
  vec3 keyD = 0.86*vec3(1.0,0.98,0.95)*max(0.0,(ndl+0.12)/1.12);
  // cast shadows from instruments / fluids onto the skin (screen-space height march toward the key light)
  float sh2=0.0; vec3 Lk=normalize(uKey);
  vec2 stepUv = (Lk.xy/max(Lk.z,0.25))/uView;
  for(int k=1;k<=14 && uHasObj==1;k++){
    float t = pow(float(k)/14.0, 1.6)*28.0;
    vec2 q = vUv + stepUv*t; float oh = objH(q);
    float rayH = H + t*1.0;
    sh2 = max(sh2, clamp((oh-rayH)/(0.6+t*0.25), 0.0, 1.0));
  }
  sh2 *= 0.62;   // the key is a large softbox: penumbrae are wide and never fully dark
  float ao = lo.ao;
  for(int k=0;k<6 && uHasObj==1;k++){ float an=float(k)*1.047; vec2 q=vUv+vec2(cos(an),sin(an))*1.6/uView; float oh=objH(q); ao -= clamp((oh-H)*0.0+ (oh>H? 0.12*exp(-max(oh-H,0.0)*0.5):0.0),0.0,0.12); }
  ao *= 1.0 - 0.35*clamp((0.5-nr.z)*2.0,0.0,1.0)*(1.0-stretch);   // cavity occlusion in furrows/pores
  ao *= 1.0 - 0.4*clamp(nr.w,0.0,1.0)*(1.0-stretch);                 // pores (scan pore mask)
  vec3 irr = (fill*mix(1.0,0.7,sh2) + keyD*(1.0-sh2)) * ao;
  // specular: two lobes (broad + sebum sheen), wet films and tense domes are smoother
  vec3 V=vec3(0,0,1); float nv=max(N.z,1e-3);
  float oil = clamp(uOil + 0.4*heat*0.0 + lo.gloss*0.6 + stretch*0.25, 0.0, 1.0);
  float wet = clamp(max(wetness, lo.wet), 0.0, 1.0);
  vec3 R = reflect(-V, N);
  float F = 0.028 + (1.0-0.028)*pow(1.0-nv,5.0);
  vec3 spec = F*(0.55*envSpec(R,0.42) + oil*0.75*envSpec(R,0.2) + wet*1.4*envSpec(R,0.06))*uExposure*0.6;
  spec += (0.5*keySpec(N,Lk0,0.45,0.028) + oil*0.9*keySpec(N,Lk0,0.24,0.028) + wet*1.2*keySpec(N,Lk0,0.09,0.02) + lo.gloss*1.6*keySpec(N,Lk0,0.11,0.03))*0.55*(1.0-sh2);
  spec += lo.gloss*0.8*F*envSpec(R,0.1)*uExposure*0.6;
  spec *= mix(1.0,0.45,sh2)*ao;
  float skinH = H;
  // patch: semi-transparent film over everything
  if(patchM>0.0){ float whiten=clamp(patchAge,0.0,1.0); alb=mix(alb, mix(vec3(0.82,0.66,0.52), vec3(0.93,0.9,0.86), whiten), patchM*(0.45+0.5*whiten)); spec += patchM*0.03*envSpec(R,0.12); }

  // ---- objects (fluids, extracted material, instruments) over the skin
  vec4 ob = texS(uObj, vUv); vec4 oc = texS(uObjCol, vUv);
  oIrr = vec4(irr, 1.0); oAlb = vec4(alb, skinH); oSpec = vec4(spec, 0.0);
  if(uDbg>0 && uDbg<7){ vec3 dc = uDbg==1 ? vec3(nr.z) : uDbg==2 ? N*0.5+0.5 : uDbg==3 ? alb : uDbg==4 ? irr*0.5 : uDbg==5 ? vec3(ch.rgb) : spec*4.0; oIrr=vec4(0.0); oAlb=vec4(0.0,0.0,0.0,0.0); oSpec=vec4(dc,1.0); return; }
  float matI = ob.y;
  if(matI > 0.5 && ob.x > skinH - 0.01){
    int mat = int(matI+0.5);
    vec3 n2 = vec3(ob.zw, sqrt(max(0.0,1.0-dot(ob.zw,ob.zw))));
    // procedural surface detail per material
    vec2 wp = p*vec2(1.0);
    if(mat==6||mat==9||mat==13) n2 = normalize(n2 + vec3(vnoise(wp*7.0)-0.5, vnoise(wp*7.0+5.0)-0.5, 0.0)*1.1 + vec3(vnoise(wp*19.0)-0.5, vnoise(wp*19.0+2.0)-0.5, 0.0)*0.5);
    if(mat==8) n2 = normalize(n2 + vec3(vnoise(wp*3.0)-0.5, vnoise(wp*3.0+3.0)-0.5, 0.0)*0.35);
    if(mat==31||mat==35) n2 = normalize(n2 + vec3(vnoise(wp*14.0)-0.5, vnoise(wp*14.0+2.0)-0.5,0.0)*0.9);
    vec3 n2e = toEnv(n2);
    vec3 R2 = reflect(-V, n2); float nv2=max(n2.z,1e-3);
    float thick = max(ob.x - skinH, 0.0);
    vec3 base = oc.rgb; float rough=0.35, f0=0.03, metal=0.0, trans=0.0;
    if(mat==6) base *= 0.86 + 0.22*vnoise(wp*5.0);
    if(mat==1){ rough=0.22; } else if(mat==2||mat==15){ rough=0.1; trans=0.35; } else if(mat==3){ rough=0.05; trans=0.85; base=vec3(0.95,0.9,0.7); }
    else if(mat==4){ rough=0.04; trans=1.0; } else if(mat==7){ rough=0.06; trans=0.6; }
    else if(mat==5){ rough=0.35; } else if(mat==6){ rough=0.7; } else if(mat==8){ rough=0.18; }
    else if(mat==9){ rough=0.6; } else if(mat==10){ rough=0.28; } else if(mat==11){ rough=0.14; trans=0.3; } else if(mat==12){ rough=0.18; }
    else if(mat==13){ rough=0.5; } else if(mat==14){ rough=0.9; }
    else if(mat==30){ rough=mix(0.48,0.16,oc.a); trans=0.62; } else if(mat==31){ rough=0.95; } else if(mat==32){ rough=0.12; metal=1.0; f0=0.85; }
    else if(mat==33){ rough=0.04; trans=0.92; f0=0.04; } else if(mat==34){ rough=0.9; trans=0.55; } else if(mat==35){ rough=0.92; }
    else if(mat==36){ rough=0.32; } else if(mat==37){ rough=0.12; trans=0.6; } else if(mat==38){ rough=0.8; } else if(mat==39){ rough=0.8; }
    else if(mat==40){ rough=0.45; base=alb; }
    float Fo = f0 + (1.0-f0)*pow(1.0-nv2,5.0);
    vec3 env = envSpec(R2, rough);
    float osh=0.0; vec2 stepUv2 = (Lk.xy/max(Lk.z,0.25))/uView;
    for(int k=1;k<=8;k++){ float t=pow(float(k)/8.0,1.6)*24.0; float oh=objH(vUv+stepUv2*t); osh=max(osh, clamp((oh-(ob.x+t))/(0.8+t*0.3),0.0,1.0)); }
    vec3 dI = (0.55*shEval(n2e)*uExposure + 0.62*vec3(1.0,0.98,0.95)*max(0.0,dot(n2,Lk0)))*mix(1.0,0.45,osh);
    vec3 sI = env*mix(1.0,0.5,osh)*uExposure*0.6 + keySpec(n2,Lk0,max(rough,0.05),1.0)*0.55*(1.0-osh);
    vec3 col;
    if(metal>0.5) col = (sI + 0.22*uExposure*shEval(n2e))*mix(vec3(0.92,0.91,0.88), base, 0.25)*(0.45+0.55*Fo) + dI*0.05;
    else {
      // wrap diffuse approximates light scattering inside creamy pus / fat / nitrile
      float wrap = (mat==1||mat==8||mat==11||mat==12||mat==30) ? 0.35 : 0.1;
      col = base*dI*(1.0-wrap*0.3) + base*shEval(normalize(n2e+vec3(0,0,wrap)))*wrap*uExposure*0.3 + Fo*sI;
    }
    if(mat==34){ // gauze: open weave lets the skin show through
      vec2 g=fract(p*2.2); float weave = smoothstep(0.08,0.2,min(min(g.x,1.0-g.x),min(g.y,1.0-g.y)));
      trans = mix(0.1, 0.75, weave);
    }
    if(trans>0.0){
      // thin liquids: tint and darken the skin under them by thickness (Beer–Lambert) and add their reflection
      vec3 sig = mat==4 ? vec3(1.6,16.0,18.0) : mat==2||mat==15 ? vec3(0.4,0.8,2.5) : mat==7 ? vec3(0.05,0.35,2.6) : mat==3 ? vec3(0.05,0.12,0.6) : vec3(0.5);
      vec3 Tr = exp(-sig*thick*1.4);
      if(mat==33||mat==34||mat==37) Tr = vec3(trans);
      if(mat==30){ float rim = pow(1.0-nv2, 2.0); Tr = mix(vec3(0.55,0.5,0.95), vec3(0.18,0.14,0.45), rim) * 0.95; }
      bool liquid = mat==2||mat==3||mat==4||mat==7||mat==15||mat==11;
      if(liquid){
        // liquids: the skin is seen only through the drop's own absorption; no light bleeds in from around it
        oIrr = vec4(0.0); oAlb = vec4(0.0,0.0,0.0, ob.x);
        oSpec = vec4(alb*irr*Tr + Fo*sI*1.15 + base*dI*(1.0-trans)*0.6, 1.0);
      } else {
        // skin seen through a glove/gauze/film: it gets light through the cover, but light scattered in from the
        // bright skin around it must not glow through as a red rim (alpha 0.75 = covered: mostly direct light)
        oIrr = vec4(irr*Tr, 0.75);
        oAlb = vec4(alb*mix(vec3(1.0), base, mat==33?0.0:0.25), max(skinH, ob.x));
        oSpec = vec4(spec*Tr + Fo*sI*(mat==33?1.4:1.0) + base*dI*(1.0-trans)*0.6, 0.0);
      }
    } else {
      oIrr = vec4(0.0); oAlb = vec4(0.0,0.0,0.0, ob.x); oSpec = vec4(col, 1.0);
    }
  }
}`;

/* ---------- separable SSS (sum-of-Gaussians skin profile, GPU Gems 3 ch.14) ---------- */
PP.SH.sssFS = `
in vec2 vUv; out vec4 o; uniform sampler2D uIrr; uniform vec2 uDir; uniform float uPxMm; uniform vec2 uVSc; uniform vec2 uRes;
vec4 texS(sampler2D t, vec2 uv){ return texture(t, clamp(uv, vec2(0.0), vec2(1.0) - 0.5/uRes) * uVSc); }
uniform float uOff[25]; uniform vec3 uW[25];
void main(){
  vec4 c=texS(uIrr,vUv); if(c.a<0.5){ o=c; return; }
  vec3 s=vec3(0.0), ws=vec3(0.0);
  for(int i=0;i<25;i++){
    vec2 uv=vUv+uDir*uOff[i]*uPxMm;
    vec4 q=texS(uIrr,uv);
    float m=q.a; vec3 w=uW[i]*m;
    s+=q.rgb*w; ws+=w;
  }
  o=vec4(s/max(ws,vec3(1e-5)),1.0);
}`;

/* ---------- composite + post: DoF, lens droplets, ACES, vignette, grain ---------- */
PP.SH.compFS = `
in vec2 vUv; out vec4 o; uniform sampler2D uSss, uAlb, uSpec, uIrr0; uniform vec2 uVSc; uniform vec2 uRes; uniform int uDbgC;
vec4 texS(sampler2D t, vec2 uv){ return texture(t, clamp(uv, vec2(0.0), vec2(1.0) - 0.5/uRes) * uVSc); }
void main(){
  vec4 a=texS(uAlb,vUv), s=texS(uSpec,vUv), i=texS(uSss,vUv), i0=texS(uIrr0,vUv);
  // 65% diffused light + 35% direct: millimetre-scale shape stays legible, skin still reads soft
  vec3 irr = i0.a>0.5 ? mix(i0.rgb, i.rgb, i0.a>0.9 ? 0.65 : 0.1) : i.rgb;
  vec3 c = s.a>0.5 ? s.rgb : a.rgb*irr + s.rgb;
  if(uDbgC==7) c=i.rgb*0.6; else if(uDbgC==8) c=i0.rgb*0.6; else if(uDbgC==9) c=vec3(i.a,i0.a,s.a);
  o=vec4(c, a.a);
}`;
PP.SH.postFS = PP.SH.common + `
in vec2 vUv; out vec4 o; uniform sampler2D uC; uniform float uPxMm2, uTime, uDof;
uniform vec4 uDrop[24]; uniform vec4 uDrop2[24]; uniform int uND; uniform float uAspect;
vec3 aces(vec3 x){ const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14; return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0); }
vec3 tap(vec2 uv){ return texS(uC, uv).rgb; }
void main(){
  vec2 uv=vUv;
  // lens droplets refract (inverted, magnified view), tint and blur what is behind them
  vec3 tint=vec3(1.0); float dropM=0.0; vec2 duv=uv;
  for(int i=0;i<uND;i++){ vec4 d=uDrop[i], d2=uDrop2[i];
    vec2 q=(uv-d.xy)*vec2(uAspect,1.0); float r=length(q)/d.z;
    if(r<1.0){ float hz=sqrt(1.0-r*r); vec2 nrm=q/d.z; duv = d.xy - (uv-d.xy)*0.55 + nrm*0.02*hz; dropM=max(dropM, 1.0-smoothstep(0.85,1.0,r));
      tint = d2.x<0.5 ? vec3(0.95,0.32,0.28)*(0.55+0.45*hz) : d2.x<1.5 ? vec3(0.97,0.93,0.78)*(0.8+0.2*hz) : vec3(1.0);
      tint = mix(vec3(1.0), tint, d.w);
    } }
  vec4 c0=texS(uC, uv);
  float coc = clamp(abs(c0.a-0.0)*uDof, 0.0, 14.0);
  vec3 c=c0.rgb;
  if(coc>0.8){ vec3 s=vec3(0.0); float w=0.0;
    for(int k=0;k<16;k++){ float an=float(k)*2.39996; float rr=sqrt((float(k)+0.5)/16.0)*coc; vec2 off=vec2(cos(an),sin(an))*rr/uRes; vec4 q=texS(uC, uv+off);
      float qc=clamp(abs(q.a)*uDof,0.0,14.0); float ww = qc>=rr*0.7 ? 1.0 : 0.2; s+=q.rgb*ww; w+=ww; }
    c = s/w; }
  if(dropM>0.0){ vec3 b=vec3(0.0); for(int k=0;k<8;k++){ float an=float(k)*0.785; b+=tap(duv+vec2(cos(an),sin(an))*0.004); } b/=8.0; c=mix(c, b*tint, dropM); c += dropM*0.04; }
  // chromatic aberration toward the frame edge
  vec2 cd=(uv-0.5); float ca=dot(cd,cd)*0.004;
  c.r = mix(c.r, texS(uC, uv+cd*ca).r, 0.6); c.b = mix(c.b, texS(uC, uv-cd*ca).b, 0.6);
  c = aces(c*1.0);
  c = pow(c, vec3(1.0/2.2));
  float vig = 1.0 - 0.32*pow(length(cd*vec2(1.0,0.85))*1.25, 2.4);
  c *= vig;
  float g = hash12(gl_FragCoord.xy + fract(uTime*7.31)*97.0)-0.5;
  c += g*0.022;
  o=vec4(c,1.0);
}`;
