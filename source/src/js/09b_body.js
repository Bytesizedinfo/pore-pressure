'use strict';
/* Whole face / upper body. A 3D bust (MakeHuman base mesh, CC0; cropped, subdivided, AO baked offline by
   tools/build_body.py) lit with the same studio HDRI, key light, ring light and chromophore skin model as the
   macro views. Each area sits at an anchor on the mesh (point + tangent frame) and its blemishes are drawn there,
   so what you popped stays popped. Zooming out past a whole patch crossfades into this view framed on the same
   spot; zooming or clicking into a marked area crossfades back into that area's macro patch. */

PP.SH.bodyVS = `
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in float aAO;
uniform mat4 uVP; uniform mat4 uLVP;
out vec3 vP; out vec3 vN; out float vAO; out vec3 vL;
void main(){ vP=aPos; vN=aNrm; vAO=aAO; vec4 l=uLVP*vec4(aPos+aNrm*1.0,1.0); vL=l.xyz*0.5+0.5; gl_Position=uVP*vec4(aPos,1.0); }`;
PP.SH.bodyShadowVS = `
layout(location=0) in vec3 aPos; uniform mat4 uLVP;
void main(){ gl_Position=uLVP*vec4(aPos,1.0); }`;
PP.SH.bodyShadowFS = `void main(){}`;
PP.SH.bodyStudio = `
vec3 studioBg(vec2 uv, float asp){ vec2 q=(uv-vec2(0.5,0.6))*vec2(asp,1.0); float r=length(q);
  return mix(vec3(0.07,0.067,0.064), vec3(0.014,0.014,0.016), smoothstep(0.05,1.05,r)); }`;
PP.SH.bodyBgFS = PP.SH.bodyStudio + `
in vec2 vUv; out vec4 o; uniform float uAspect;
void main(){ o=vec4(studioBg(vUv,uAspect),0.0); }`;
PP.SH.bodyCopyFS = `
in vec2 vUv; out vec4 o; uniform sampler2D uT;
void main(){ o=texture(uT,vUv); }`;

PP.SH.bodyFS = PP.SH.bodyStudio + `
in vec3 vP; in vec3 vN; in float vAO; in vec3 vL;
layout(location=0) out vec4 o;
uniform mat3 uVR; uniform vec3 uEyePos; uniform vec2 uRes;
uniform sampler2D uChromo, uNrm, uDetail, uEnvP, uLes, uPhysC, uFilmC;
uniform highp sampler2DShadow uShadow;
uniform float uTile, uHmm, uDetK, uYTop;
uniform vec3 uTone, uToneA, uVM, uVH, uVS;
uniform vec3 uSH[9]; uniform float uYaw, uExposure, uRing; uniform vec3 uKey;
uniform vec4 uAP[16]; uniform vec4 uAT[16]; uniform vec4 uAB[16]; uniform vec4 uAN[16];
uniform int uNA, uHover, uCur; uniform float uShowAll, uBloodOn;
uniform vec3 uNose, uMouth, uEyeL, uEyeR, uHead;
uniform int uIsEye;

float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x), u.y); }
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
  float ang = acos(clamp(R.z,-1.0,1.0)); float w = 0.035+rough*0.9;
  c += uRing * 22.0 * exp(-pow((ang-0.20)/w,2.0)) * (0.06/(w+0.03));
  return c;
}
vec3 keySpec(vec3 N, vec3 L, vec3 V, float rough, float f0){
  vec3 H=normalize(L+V);
  float nh=max(dot(N,H),0.0), nl=max(dot(N,L),0.0), nv=max(dot(N,V),1e-3), vh=max(dot(V,H),0.0);
  float a=max(rough*rough,0.002); float d=nh*nh*(a*a-1.0)+1.0; float D=a*a/(3.14159*d*d);
  float F=f0+(1.0-f0)*pow(1.0-vh,5.0);
  float k=a*0.5; float G=(nl/(nl*(1.0-k)+k))*(nv/(nv*(1.0-k)+k));
  return vec3(1.0,0.98,0.95)*D*F*G/(4.0*nv+1e-3);
}
// soft key-light shadow: 12-tap PCF over the hardware-filtered shadow map (the key is a large softbox)
float keyShadow(vec3 l){
  if(l.x<0.0||l.y<0.0||l.x>1.0||l.y>1.0) return 1.0;
  float s=0.0; float r=2.2/1024.0;
  for(int k=0;k<12;k++){ float a=float(k)*2.39996; float rr=sqrt((float(k)+0.5)/12.0)*r*1.8;
    s+=texture(uShadow, vec3(l.xy+vec2(cos(a),sin(a))*rr, l.z-0.0015)); }
  return s/12.0;
}
float browMask(vec3 p, vec3 eye, float side){
  float dx=(p.x-eye.x)*side, dy=p.y-eye.y;
  if(p.z<eye.z-6.0) return 0.0;
  float yc = 13.5 + 4.0*exp(-pow((dx-5.0)/13.0,2.0)) - 0.006*max(dx-12.0,0.0)*max(dx-12.0,0.0);
  float th = mix(8.0, 2.6, smoothstep(-16.0, 24.0, dx));
  float m = 1.0-smoothstep(th*0.3, th*0.58, abs(dy-yc));
  m *= smoothstep(-20.0,-14.0,dx)*(1.0-smoothstep(20.0,26.0,dx));
  float ang = mix(1.25, 0.2, smoothstep(-16.0, 18.0, dx));
  vec2 q=vec2(dx,dy); float c=dot(q,vec2(-sin(ang),cos(ang))), a=dot(q,vec2(cos(ang),sin(ang)));
  float strand = smoothstep(0.35,0.75,vnoise(vec2(c*3.2, a*0.3)));
  float edge = 1.0-smoothstep(th*0.15, th*0.58, abs(dy-yc));
  return m*mix(0.45+0.55*strand, 1.0, edge*0.5);
}

void main(){
  vec3 Ng = normalize(vN);
  if(!gl_FrontFacing) Ng=-Ng;
  vec3 V = normalize(uEyePos-vP);
  vec3 Lv = normalize(uKey);
  vec3 Vv = uVR*V;
  float vis = keyShadow(vL);
  float ao = mix(1.0, vAO, 0.9);
  vec3 col;
  if(uIsEye==1){
    // eyeball: wet cornea over iris + sclera; ring-light catchlight comes from envSpec
    vec3 ec = vP.x>0.0 ? uEyeL : uEyeR;
    vec3 q = normalize(vP-ec);
    vec3 gz = normalize(vec3(-sign(vP.x)*0.04,-0.03,1.0));
    float ang = acos(clamp(dot(q,gz),-1.0,1.0));
    vec3 ex = normalize(cross(vec3(0,1,0),gz)), ey = cross(gz,ex);
    float az = atan(dot(q,ey), dot(q,ex));
    float fib = vnoise(vec2(az*14.0, ang*26.0))*0.6 + vnoise(vec2(az*40.0, ang*9.0))*0.4;
    vec3 irisC = mix(vec3(0.06,0.035,0.018), vec3(0.24,0.14,0.06), smoothstep(0.12,0.46,ang))*(0.7+0.6*fib);
    vec3 scl = vec3(0.78,0.74,0.70)*(1.0-0.2*smoothstep(0.8,1.5,ang));
    scl = mix(scl, vec3(0.7,0.42,0.38), 0.25*smoothstep(0.9,1.4,ang)*vnoise(vec2(az*20.0,ang*6.0)));
    float iris = 1.0-smoothstep(0.47,0.51,ang), pupil = 1.0-smoothstep(0.13,0.155,ang);
    vec3 alb = mix(scl, irisC, iris); alb = mix(alb, vec3(0.006), pupil);
    alb *= 1.0-0.6*exp(-pow((ang-0.49)/0.035,2.0));
    vec3 Nv = uVR*Ng;
    float nl = max(dot(Nv,Lv),0.0);
    vec3 irr = (0.42*shEval(toEnv(Nv))*uExposure + 0.86*vec3(1.0,0.98,0.95)*nl*vis)*ao;
    vec3 Rv = reflect(-Vv, Nv); float nv=max(dot(Nv,Vv),1e-3);
    float F = 0.025+(1.0-0.025)*pow(1.0-nv,5.0);
    vec3 spec = (F*envSpec(Rv,0.04)*uExposure*0.9 + keySpec(Nv,Lv,Vv,0.06,0.025)*0.7*vis)*ao;
    col = alb*irr + spec;
    o = vec4(col, 0.0); return;
  }
  // ---- skin: triplanar photo maps in millimetres
  vec3 bw = pow(abs(Ng), vec3(4.0)); bw /= dot(bw, vec3(1.0));
  vec2 ux=vP.zy/uTile, uy=vP.xz/uTile+0.37, uz=vP.xy/uTile+0.71;
  vec4 chx=texture(uChromo,ux), chy=texture(uChromo,uy), chz=texture(uChromo,uz);
  vec4 nrx=texture(uNrm,ux), nry=texture(uNrm,uy), nrz=texture(uNrm,uz);
  vec4 dtx=texture(uDetail,ux), dty=texture(uDetail,uy), dtz=texture(uDetail,uz);
  vec4 ch = chx*bw.x+chy*bw.y+chz*bw.z, nr = nrx*bw.x+nry*bw.y+nrz*bw.z, dt = dtx*bw.x+dty*bw.y+dtz*bw.z;
  vec3 gW = (vec3(0.0,nrx.y,nrx.x)*bw.x + vec3(nry.x,0.0,nry.y)*bw.y + vec3(nrz.x,nrz.y,0.0)*bw.z)*uHmm/uTile;
  // ---- regions (landmarks from the mesh)
  vec3 p = vP;
  float regHem = 0.05, regMel = 0.0, oil = 0.3;
  regHem += 0.07*exp(-dot(p-uNose,p-uNose)/(16.0*16.0));
  vec3 ckL = vec3(42.0, uNose.y-12.0, uNose.z-36.0), ckR = vec3(-42.0, uNose.y-12.0, uNose.z-36.0);
  regHem += 0.05*(exp(-dot(p-ckL,p-ckL)/(24.0*24.0)) + exp(-dot(p-ckR,p-ckR)/(24.0*24.0)));
  float ear = smoothstep(62.0,70.0,abs(p.x))*smoothstep(uEyeL.y-48.0,uEyeL.y-36.0,p.y)*(1.0-smoothstep(uEyeL.y+8.0,uEyeL.y+20.0,p.y))*smoothstep(uHead.z-50.0,uHead.z-35.0,p.z)*(1.0-smoothstep(uHead.z+10.0,uHead.z+25.0,p.z));
  regHem += 0.1*ear;
  vec2 lq = vec2(p.x/22.0, (p.y-uMouth.y)/(p.y>uMouth.y ? 7.5 : 9.0));
  float lip = (1.0-smoothstep(0.72,1.0,length(lq)))*smoothstep(uMouth.z-22.0,uMouth.z-14.0,p.z);
  regHem += 0.42*lip; regMel += 0.25*lip*uTone.x*0.3;
  float und = exp(-pow((p.x-uEyeL.x)/13.0,2.0)-pow((p.y-uEyeL.y+13.0)/7.0,2.0)) + exp(-pow((p.x-uEyeR.x)/13.0,2.0)-pow((p.y-uEyeR.y+13.0)/7.0,2.0));
  regMel += 0.1*uTone.x*und*step(uEyeL.z-12.0,p.z);
  float tz = (1.0-smoothstep(30.0,45.0,abs(p.x)))*smoothstep(uEyeL.y+8.0,uEyeL.y+20.0,p.y)*step(uHead.z,p.z) + (1.0-smoothstep(10.0,18.0,abs(p.x)))*smoothstep(uNose.y-8.0,uNose.y,p.y)*(1.0-smoothstep(uEyeL.y-4.0,uEyeL.y+4.0,p.y))*step(uNose.z-40.0,p.z);
  oil += 0.35*clamp(tz,0.0,1.0) + 0.3*lip;
  // shaved scalp: stubble shadow above the hairline (elevation around the head centre by azimuth)
  vec3 hd = p-uHead; float azh = abs(atan(hd.x, hd.z)); float el = atan(hd.y, length(hd.xz));
  float elH = 0.92 - 0.45*smoothstep(0.0,1.57,azh) - 1.0*smoothstep(1.57,3.14,azh);
  float scalp = smoothstep(elH-0.02, elH+0.07, el)*(1.0-ear);
  // ---- blemishes of every area at their anchors (+ the live physiology/film of the current area)
  float hemL=0.0, dark=0.0, headM=0.0, crater=0.0, hema=0.0, outline=0.0, gloss=0.0; vec3 headC=vec3(0.9);
  vec3 gL = vec3(0.0); vec4 ph0=vec4(1.0,0.0,0.0,0.0), film=vec4(0.0);
  for(int a=0;a<16;a++){
    if(a>=uNA) break;
    vec3 dd = p-uAP[a].xyz; float hs = uAP[a].w;
    float w = dot(dd, uAN[a].xyz);
    if(abs(w)>32.0 || dot(Ng,uAN[a].xyz)<0.05) continue;
    vec2 X = vec2(dot(dd,uAT[a].xyz), dot(dd,uAB[a].xyz));
    if(max(abs(X.x),abs(X.y))>hs+3.0) continue;
    float rr=hs*0.12; vec2 qb=abs(X)-vec2(hs-rr); float sd=length(max(qb,0.0))+min(max(qb.x,qb.y),0.0)-rr;
    float px=length(fwidth(X));
    float ol=(1.0-smoothstep(px*0.6,px*1.8,abs(sd)));
    outline = max(outline, ol*(a==uHover ? 0.85 : min(uShowAll,1.0)*0.45));
    if(a==uHover && sd<0.0) outline = max(outline, 0.06);
    if(a==uCur && sd<0.0){ vec2 pu=X/(2.0*hs)+0.5; ph0=texture(uPhysC,pu); film=texture(uFilmC,pu); }
    int r0=int(uAT[a].w), cnt=int(uAB[a].w);
    for(int i=0;i<64;i++){
      if(i>=cnt) break;
      vec4 A=texelFetch(uLes, ivec2(0,r0+i), 0);
      vec2 q=X-A.xy; float R=max(A.z,0.1); float r2=dot(q,q);
      if(r2>(R*2.6+1.0)*(R*2.6+1.0)) continue;
      vec4 B=texelFetch(uLes, ivec2(1,r0+i), 0), C=texelFetch(uLes, ivec2(2,r0+i), 0);
      float r=sqrt(r2);
      hemL += B.y*0.42*exp(-r2/(R*R*2.4));
      if(r<R){ float s=1.0-r2/(R*R); vec2 g2=-3.0*A.w*sqrt(s)*q/(R*R); gL += g2.x*uAT[a].xyz + g2.y*uAB[a].xyz; gloss=max(gloss, s*clamp(A.w/R,0.0,1.0)); }
      if(B.x>0.0){ float hm=1.0-smoothstep(B.x*0.65,B.x,r); if(hm>headM){ headM=hm; headC=C.rgb; } }
      dark = max(dark, B.z*(1.0-smoothstep(R*0.3,R*0.5,r)));
      crater = max(crater, 1.0-smoothstep(B.w*0.75,B.w,r));
      hema = max(hema, C.w*exp(-r2/(R*R*3.0)));
    }
  }
  gW += gL;
  gW -= Ng*dot(gW,Ng);
  vec3 N = normalize(Ng - gW);
  // ---- chromophores -> albedo (same model and tone means as the macro skin)
  vec3 cn = (ch.rgb-0.5)*6.0;
  vec2 mq = bw.x>0.5 ? p.zy : bw.y>0.5 ? p.xz : p.xy;
  float mot1 = vnoise(mq*0.045)*0.6 + vnoise(mq*0.11+3.1)*0.4, mot2 = vnoise(mq*0.07+7.0)*0.6 + vnoise(mq*0.19+1.3)*0.4;
  float m = uTone.x + uToneA.x*cn.x + regMel + uTone.x*0.12*(mot1-0.5);
  float perf = ph0.r;
  float hem = (uTone.y + uToneA.y*cn.y + regHem + hemL + 0.07*(mot2-0.5))*mix(0.42,1.0,clamp(perf,0.0,1.6)) + 0.22*max(0.0,perf-1.0) + 0.22*ph0.b;
  float sh = uTone.z + uToneA.z*cn.z*0.6;
  float deox = hema*0.8 + ph0.a*0.6;
  vec3 alb = exp(-(m*uVM + hem*uVH + sh*uVS + deox*vec3(0.62,0.68,0.42)));
  vec3 dr = dt.rgb*2.0; float dl = dot(dr, vec3(0.2126,0.7152,0.0722));
  alb *= pow(clamp(mix(vec3(dl),dr,0.4),0.35,1.28), vec3(uDetK));
  alb *= mix(1.0, 0.8, clamp(nr.w*1.2,0.0,1.0));
  float brow = max(browMask(p,uEyeL,1.0), browMask(p,uEyeR,-1.0));
  alb = mix(alb, vec3(0.04,0.028,0.02), clamp(brow,0.0,1.0)*0.85);
  alb = mix(alb, alb*vec3(0.6,0.61,0.66), 0.55*scalp);
  alb = mix(alb, headC, headM*0.88);
  alb = mix(alb, vec3(0.05,0.035,0.025), dark*0.85);
  alb = mix(alb, vec3(0.36,0.05,0.04), crater*0.85);
  alb = mix(alb, vec3(0.86,0.78,0.5), clamp(film.g,0.0,1.0)*0.55);
  alb *= mix(vec3(1.0), vec3(0.62,0.33,0.12), clamp(film.a,0.0,1.0)*0.85);
  float wet = clamp(film.b,0.0,1.0);
  alb = mix(alb, mix(vec3(0.16,0.03,0.02), vec3(0.42,0.02,0.02), wet), clamp(film.r*1.2,0.0,0.92)*uBloodOn);
  // ---- lighting in view space (the studio rig follows the camera, as in the macro views)
  vec3 Nv = uVR*N, Ngv = uVR*Ng;
  // pre-integrated skin: red light scatters furthest, so it sees a smoother normal and wraps further
  vec3 ndl = vec3(dot(normalize(mix(Nv,Ngv,0.7)),Lv), dot(normalize(mix(Nv,Ngv,0.35)),Lv), dot(Nv,Lv));
  vec3 wrap = vec3(0.3,0.14,0.1);
  vec3 visC = vec3(pow(vis,0.55), pow(vis,0.85), vis);
  vec3 keyD = 0.86*vec3(1.0,0.98,0.95)*max(vec3(0.0),(ndl+wrap)/(1.0+wrap))*visC;
  vec3 fill = 0.42*shEval(toEnv(normalize(mix(Nv,Ngv,0.5))))*uExposure;
  vec3 irr = (fill + keyD)*ao;
  irr *= mix(vec3(1.0), vec3(1.0,0.86,0.82), (1.0-ao)*0.6);
  vec3 Rv = reflect(-Vv, Nv); float nv = max(dot(Nv,Vv),1e-3);
  float F = 0.028+(1.0-0.028)*pow(1.0-nv,5.0);
  vec3 spec = F*(0.55*envSpec(Rv,0.42) + oil*0.75*envSpec(Rv,0.2) + wet*film.r*1.4*envSpec(Rv,0.06))*uExposure*0.6;
  spec += (0.5*keySpec(Nv,Lv,Vv,0.45,0.028) + oil*0.9*keySpec(Nv,Lv,Vv,0.24,0.028) + gloss*1.4*keySpec(Nv,Lv,Vv,0.12,0.03))*0.55*vis;
  spec *= ao;
  col = alb*irr + spec;
  // portrait fade at the cropped chest / back
  float ycut = uYTop - (415.0 + 55.0*tanh(-p.z/40.0));
  vec2 suv = gl_FragCoord.xy/uRes;
  float keep = smoothstep(ycut+3.0, ycut+70.0, p.y)*(1.0-smoothstep(150.0, 205.0, abs(p.x)));
  col = mix(studioBg(suv, uRes.x/uRes.y), col, keep);
  col = mix(col, vec3(0.62,0.56,1.1), outline);
  o = vec4(col, 0.0);
}`;

/* ---------------- tiny matrix helpers (column-major) ---------------- */
PP.M4 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp3: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  persp(fy, asp, n, f) { const t = 1 / Math.tan(fy / 2), o = new Float32Array(16); o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = (2 * f * n) / (n - f); return o; },
  ortho(r, n, f) { const o = new Float32Array(16); o[0] = 1 / r; o[5] = 1 / r; o[10] = -2 / (f - n); o[14] = -(f + n) / (f - n); o[15] = 1; return o; },
  look(eye, tgt, up) {
    const M = PP.M4, z = M.norm(M.sub(eye, tgt)), x = M.norm(M.cross(up, z)), y = M.cross(z, x), o = new Float32Array(16);
    o[0] = x[0]; o[4] = x[1]; o[8] = x[2]; o[12] = -M.dot(x, eye);
    o[1] = y[0]; o[5] = y[1]; o[9] = y[2]; o[13] = -M.dot(y, eye);
    o[2] = z[0]; o[6] = z[1]; o[10] = z[2]; o[14] = -M.dot(z, eye);
    o[15] = 1;
    return { m: o, x, y, z };
  },
  mul(a, b) { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; },
};

PP.Body = function (R, W) {
  this.R = R; this.W = W; this.G = R.G; this.gl = R.gl;
  const G = this.G, SH = PP.SH, gl = this.gl;
  this.P = {
    body: G.program('body', SH.bodyVS, SH.bodyFS),
    shadow: G.program('bodyShadow', SH.bodyShadowVS, SH.bodyShadowFS),
    bg: G.program('bodyBg', SH.fsVS, SH.bodyBgFS),
    copy: G.program('bodyCopy', SH.fsVS, SH.bodyCopyFS),
  };
  this.mode = 'macro';      // macro | entering | body | diving | leaving
  this.fade = 0;            // 0 = macro on screen, 1 = body on screen
  this.fovy = (24 * Math.PI) / 180;
  this.cam = { p: [0, 712, 80], yaw: 0, pitch: 0.06, dist: 800 };
  this.tgt = { p: [0, 712, 80], yaw: 0, pitch: 0.06, dist: 800 };
  this.tw = null;           // scripted camera move {a, b, t, dur, ease}
  this.hover = -1; this.showAll = 0; this.dirty = true;
  this.lesData = new Float32Array(3 * 1024 * 4);
  this.lesTex = G.tex(3, 1024, { ifmt: gl.RGBA32F, fmt: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST });
  this.spotN = 0; this.preview = null;
  this._lesT = -1;
  this.ptrs = new Map();
  this.u9 = new Float32Array(9);
  this.ua = { p: new Float32Array(64), t: new Float32Array(64), b: new Float32Array(64), n: new Float32Array(64) };
};

PP.Body.prototype.load = function () {
  if (this._load) return this._load;
  this._load = (async () => {
    const gl = this.gl, G = this.G, R = this.R;
    const [d, face] = await Promise.all([
      fetch('models/bust.json').then((r) => { if (!r.ok) throw new Error('bust.json ' + r.status); return r.json(); }),
      R.loadSet('deep'),
    ]);
    const dec = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
    const qp = new Int16Array(dec(d.pos)), n = d.nverts, pos = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) pos[i] = qp[i] * d.posQ + d.posOff[i % 3];
    const nrm = new Int8Array(dec(d.nrm)), ao = new Uint8Array(dec(d.ao)), idx = new Uint16Array(dec(d.idx));
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const buf = (data, loc, size, type, normd) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, normd, 0, 0); };
    buf(pos, 0, 3, gl.FLOAT, false); buf(nrm, 1, 3, gl.BYTE, true); buf(ao, 2, 1, gl.UNSIGNED_BYTE, true);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.nEye = d.eyeCount; this.eyeStart = d.eyeStart; this.nBody = d.eyeStart;
    this.pos = pos; this.nrm = nrm; this.idx = idx; this.meta = d; this.face = face;
    this.anchors = {};
    for (const [id, a] of Object.entries(d.anchors)) if (PP.AREAS[id]) this.anchors[id] = a;
    this.order = Object.keys(this.anchors);
    // shadow map (depth texture with hardware comparison)
    const st = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, st);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, 1024, 1024);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    const sfb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, sfb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, st, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.shadow = { t: st, fb: sfb };
    this.ready = true;
  })();
  this._load.catch((e) => PP.diag.error('Body model: ' + (e.message || e)));
  return this._load;
};

// render target at canvas resolution; 4x MSAA when the driver supports float multisampling
PP.Body.prototype.ensureTargets = function () {
  const gl = this.gl, G = this.G, R = this.R, cw = R.cw, ch = R.ch;
  if (this.tw0 === cw && this.th0 === ch) return;
  this.tw0 = cw; this.th0 = ch;
  if (this.rt) G.freeTarget(this.rt);
  if (this.ms) { gl.deleteFramebuffer(this.ms.fb); gl.deleteRenderbuffer(this.ms.cb); gl.deleteRenderbuffer(this.ms.db); this.ms = null; }
  this.rt = G.target(cw, ch, [{ ifmt: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT }], true);
  if (this.samples === undefined) {
    let s = null; try { s = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES); } catch (e) { s = null; }
    this.samples = s && s.length ? Math.min(4, s[0]) : 0;
  }
  if (this.samples > 1) {
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const cb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, cb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RGBA16F, cw, ch);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, cb);
    const db = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, db);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, cw, ch);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, db);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) this.ms = { fb, cb, db };
    else { gl.deleteFramebuffer(fb); gl.deleteRenderbuffer(cb); gl.deleteRenderbuffer(db); this.samples = 0; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  this.dirty = true;
};

/* ---------------- camera ---------------- */
PP.Body.prototype.aspect = function () { return (this.R.cw || 16) / (this.R.ch || 9); };
PP.Body.prototype.distW = function (w) { return w / (2 * Math.tan(this.fovy / 2) * this.aspect()); };
PP.Body.prototype.distH = function (h) { return h / (2 * Math.tan(this.fovy / 2)); };
PP.Body.prototype.widthAt = function (dist) { return 2 * dist * Math.tan(this.fovy / 2) * this.aspect(); };
PP.Body.prototype.dirOf = function (yaw, pitch) { return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]; };
PP.Body.prototype.viewOf = function (a) {   // camera state looking straight at an anchor
  const n = a.n;
  return { yaw: Math.atan2(n[0], n[2]), pitch: Math.asin(PP.clamp(n[1], -1, 1)) };
};
PP.Body.prototype.overview = function (id) {
  const M = this.meta, hc = M.headCenter;
  const A = PP.AREAS[id], a = this.anchors[id];
  if (A && A.spot && a) {
    const yawN = Math.atan2(a.n[0], a.n[2]);
    if (A.region === 'upperback') return { p: [0, 590, 10], yaw: Math.PI + PP.clamp(Math.atan2(-a.n[0], -a.n[2]), -0.8, 0.8) * 0.6, pitch: 0.12, dist: this.distH(430) };
    if (A.region === 'chest' || A.region === 'shoulder') return { p: [0, 575, 50], yaw: PP.clamp(yawN, -1.1, 1.1) * 0.7, pitch: 0.15, dist: this.distH(430) };
    if (A.region === 'neck') return a.n[2] < -0.3 ? { p: [0, 650, 20], yaw: Math.PI, pitch: 0.1, dist: this.distH(340) } : { p: [0, 650, 70], yaw: PP.clamp(yawN, -0.8, 0.8) * 0.6, pitch: -0.05, dist: this.distH(340) };
    if (A.region === 'scalp') return { p: [0, hc[1] + 10, hc[2]], yaw: yawN * 0.8, pitch: 0.6, dist: this.distH(300) };
    return { p: [0, hc[1] - 8, hc[2] + 8], yaw: PP.clamp(yawN, -1.3, 1.3) * 0.75, pitch: 0.05, dist: this.distH(330) };
  }
  if (id === 'back') return { p: [0, 610, 20], yaw: Math.PI, pitch: 0.12, dist: this.distH(430) };
  if (id === 'scalp') return { p: [0, hc[1] + 10, hc[2]], yaw: 0.35, pitch: 0.72, dist: this.distH(300) };
  const yaw = a ? PP.clamp(Math.atan2(a.n[0], a.n[2]), -0.7, 0.7) * 0.75 : 0;
  return { p: [0, hc[1] - 8, hc[2] + 8], yaw, pitch: 0.05, dist: this.distH(330) };
};
PP.Body.prototype.copyCam = (c) => ({ p: c.p.slice(), yaw: c.yaw, pitch: c.pitch, dist: c.dist });
PP.Body.prototype.tween = function (to, dur, ease) {
  this.tw = { a: this.copyCam(this.cam), b: to, t: 0, dur, ease: ease || 'inout' };
  this.tgt = this.copyCam(to);
};
PP.Body.prototype.ease = function (dt) {
  const c = this.cam, M = PP.M4;
  const before = c.p[0] + c.p[1] * 3 + c.p[2] * 7 + c.yaw * 11 + c.pitch * 13 + c.dist * 0.5;
  if (this.tw) {
    const T = this.tw; T.t += dt;
    const x = PP.clamp(T.t / T.dur, 0, 1);
    const e = T.ease === 'out' ? 1 - Math.pow(1 - x, 3) : x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    let dy = T.b.yaw - T.a.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    c.p = M.lerp3(T.a.p, T.b.p, e); c.yaw = T.a.yaw + dy * e; c.pitch = T.a.pitch + (T.b.pitch - T.a.pitch) * e;
    c.dist = Math.exp(Math.log(T.a.dist) + (Math.log(T.b.dist) - Math.log(T.a.dist)) * e);
    if (x >= 1) { this.tw = null; this.tgt = this.copyCam(c); }
  } else {
    const t = this.tgt, k = 1 - Math.exp(-dt / 0.09);
    let dy = t.yaw - c.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    c.p = M.lerp3(c.p, t.p, k); c.yaw += dy * k; c.pitch += (t.pitch - c.pitch) * k;
    c.dist = Math.exp(Math.log(c.dist) + (Math.log(t.dist) - Math.log(c.dist)) * k);
  }
  const after = c.p[0] + c.p[1] * 3 + c.p[2] * 7 + c.yaw * 11 + c.pitch * 13 + c.dist * 0.5;
  return Math.abs(after - before) > 1e-4;
};
PP.Body.prototype.matrices = function () {
  const M = PP.M4, c = this.cam;
  const dir = this.dirOf(c.yaw, c.pitch);
  const eye = M.add(c.p, M.scale(dir, c.dist));
  const V = M.look(eye, c.p, [0, 1, 0]);
  const P = M.persp(this.fovy, this.aspect(), Math.max(2, c.dist * 0.08), c.dist + 1800);
  this.eye = eye; this.basis = V; this.VP = M.mul(P, V.m);
  const VR = this.u9; for (let j = 0; j < 3; j++) { VR[j * 3] = V.x[j]; VR[j * 3 + 1] = V.y[j]; VR[j * 3 + 2] = V.z[j]; }
  // key light: fixed relative to the camera (the studio rig moves with it); shadow map is world-aligned to it
  const k = M.norm(this.W.keyDir);
  const Lw = M.norm(M.add(M.add(M.scale(V.x, k[0]), M.scale(V.y, k[1])), M.scale(V.z, k[2])));
  const ctr = [0, 627, 54];
  const LV = M.look(M.add(ctr, M.scale(Lw, 700)), ctr, Math.abs(Lw[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0]);
  this.LVP = M.mul(M.ortho(330, 300, 1100), LV.m);
};

/* ---------------- picking (CPU ray cast, Moller-Trumbore over the body triangles) ---------------- */
PP.Body.prototype.ray = function (sx, sy) {
  const r = this.R.canvas.getBoundingClientRect(), M = PP.M4, B = this.basis;
  const nx = ((sx - r.left) / r.width) * 2 - 1, ny = 1 - ((sy - r.top) / r.height) * 2;
  const ty = Math.tan(this.fovy / 2), tx = ty * this.aspect();
  const d = M.norm(M.add(M.add(M.scale(B.x, nx * tx), M.scale(B.y, ny * ty)), M.scale(B.z, -1)));
  return { o: this.eye, d };
};
PP.Body.prototype.pick = function (sx, sy) {
  if (!this.ready || !this.basis) return null;
  const { o, d } = this.ray(sx, sy);
  return this.raycast(o, d);
};
PP.Body.prototype.raycast = function (o, d) {
  if (!this.ready) return null;
  d = PP.M4.norm(d);
  const P = this.pos, I = this.idx;
  let best = Infinity;
  for (let k = 0; k < this.nBody; k += 3) {
    const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-9 && det < 1e-9) continue;
    const inv = 1 / det, tx = o[0] - P[a], ty = o[1] - P[a + 1], tz = o[2] - P[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 0 && t < best) best = t;
  }
  if (!isFinite(best)) return null;
  const p = PP.M4.add(o, PP.M4.scale(d, best));
  return { p, area: this.areaAt(p) };
};
PP.Body.prototype.areaAt = function (p, skip) {
  const M = PP.M4; let best = null, bs = 1;
  for (const id of this.order) {
    if (id === skip) continue;
    const a = this.anchors[id], hs = PP.AREAS[id].size / 2, dd = M.sub(p, a.p);
    if (Math.abs(M.dot(dd, a.n)) > 32) continue;
    const s = Math.max(Math.abs(M.dot(dd, a.t)), Math.abs(M.dot(dd, a.b))) / hs;
    if (s < bs) { bs = s; best = id; }
  }
  return best;
};

/* ---------------- close-ups anywhere ---------------- */
// smoothed surface normal at a mesh point (vertex normals within ~6 mm)
PP.Body.prototype.normalAt = function (p) {
  const P = this.pos, N = this.nrm; let nx = 0, ny = 0, nz = 0;
  for (let i = 0, n = P.length / 3; i < n; i++) {
    const dx = P[i * 3] - p[0], dy = P[i * 3 + 1] - p[1], dz = P[i * 3 + 2] - p[2], d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 144) continue;
    const w = Math.exp(-d2 / 36); nx += N[i * 3] * w; ny += N[i * 3 + 1] * w; nz += N[i * 3 + 2] * w;
  }
  return PP.M4.norm([nx, ny, nz]);
};
// which part of the body a point is on (landmarks from the model); eyes and lips get no close-up
PP.Body.prototype.regionAt = function (p, n) {
  const M = this.meta, hc = M.headCenter, eL = M.eyes[0], eR = M.eyes[1], mo = M.mouth;
  const D = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const dEye = Math.min(D(p, eL), D(p, eR));
  if (dEye < 18) return { bad: 'eye', dEye };
  if (Math.abs(p[0]) < 24 && p[1] > mo[1] - 9 && p[1] < mo[1] + 8 && p[2] > mo[2] - 18) return { bad: 'lips', dEye };
  const chinY = 611, neckBot = 572;
  const d = [p[0] - hc[0], p[1] - hc[1], p[2] - hc[2]];
  const az = Math.abs(Math.atan2(d[0], d[2])), el = Math.atan2(d[1], Math.hypot(d[0], d[2]));
  const sm = (a, b, x) => { const t = PP.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const elH = 0.92 - 0.45 * sm(0, 1.57, az) - 1.0 * sm(1.57, 3.14, az);
  const ear = Math.abs(p[0]) > 62 && p[1] > eL[1] - 48 && p[1] < eL[1] + 20 && p[2] > hc[2] - 50 && p[2] < hc[2] + 25;
  let key, name = null;
  if (ear) key = 'ear';
  else if (p[1] > chinY && n[1] < -0.55 && p[1] < mo[1]) { key = 'neck'; name = 'Under the chin'; }
  else if (p[1] > chinY && el > elH + 0.03) key = 'scalp';
  else if (p[1] > chinY && n[2] < -0.3) { key = 'neck'; name = 'Back of the neck'; }
  else if (p[1] > chinY) {
    if (p[1] > eL[1] + 10 && Math.abs(p[0]) < 42) key = 'forehead';
    else if (Math.abs(p[0]) > 44 && p[1] > eL[1] - 20) key = 'temple';
    else if (p[1] < mo[1] + 6) key = Math.abs(p[0]) < 22 ? 'chin' : 'jaw';
    else key = 'cheek';
  } else if (p[1] > neckBot && Math.abs(p[0]) < 62) { key = 'neck'; if (n[2] < -0.3) name = 'Back of the neck'; }
  else if (n[2] < -0.3) key = 'upperback';
  else if (Math.abs(p[0]) > 95 || n[1] > 0.6) key = 'shoulder';
  else key = 'chest';
  if (!name) {
    const t = PP.SPOTS[key].name, side = p[0] > 22 ? 'Left ' : p[0] < -22 ? 'Right ' : '';
    name = t[0] === t[0].toUpperCase() ? t : side ? side + t : t[0].toUpperCase() + t.slice(1);
  }
  return { key, name, dEye };
};
// the close-up a hit point would open (frame, size, region) without creating it
PP.Body.prototype.spotFor = function (hit) {
  const M = PP.M4, p = hit.p, n = this.normalAt(p), r = this.regionAt(p, n);
  if (r.bad) return r;
  const T = PP.SPOTS[r.key];
  let t = M.cross([0, 1, 0], n); if (Math.hypot(t[0], t[1], t[2]) < 0.2) t = M.cross([0, 0, 1], n);
  t = M.norm(t); const b = M.cross(n, t);
  // keep the eye out of the patch where possible
  const size = r.key === 'ear' ? T.size : PP.clamp(Math.min(T.size, 2 * (r.dEye - 8)), 28, T.size);
  return { key: r.key, name: r.name, p: p.slice(), n, t, b, size, T };
};
PP.Body.prototype.makeSpot = function (f) {
  if (!f || f.bad) return null;
  const W = this.W, UI = PP.main.UI, M = PP.M4;
  // at most 9 close-ups: recycle the oldest one you're not in
  const spots = this.order.filter((id) => PP.AREAS[id] && PP.AREAS[id].spot);
  if (spots.length >= 9) { const old = spots.find((id) => id !== W.areaId); if (old) { UI.toast('', 'Close-up recycled', PP.AREAS[old].name + ' was forgotten to make room (9 close-ups at a time).'); this.dropSpot(old); } }
  const id = 'spot' + (++this.spotN), T = f.T, base = PP.AREAS[T.base];
  let name = f.name; const same = Object.values(PP.AREAS).filter((A) => A.spot && A.name.replace(/ \d+$/, '') === name).length;
  if (same) name += ' ' + (same + 1);
  // gravity in the patch frame: reclined in the clinic chair, or prone for the back
  const g = f.n[2] < -0.3 ? [0, 0, 1] : M.norm([0, -0.9, -0.42]);
  PP.AREAS[id] = Object.assign({}, base, { name, size: f.size, view: (T.view * f.size) / T.size, mix: T.mix, base: T.base, spot: true, region: f.key,
    grav: [M.dot(g, f.t), M.dot(g, f.b), M.dot(g, f.n)], rstl: T.rstl == null ? base.rstl : T.rstl });
  this.anchors[id] = { p: f.p, n: f.n, t: f.t, b: f.b };
  this.order.push(id);
  // its blemishes: never inside another area's patch, never over the eyes or lips
  const eyes = this.meta.eyes, mo = this.meta.mouth;
  const accept = (x, y, R) => {
    const q = M.add(M.add(f.p, M.scale(f.t, x)), M.scale(f.b, y));
    if (this.areaAt(q, id)) return false;
    for (const e of eyes) if (Math.hypot(q[0] - e[0], q[1] - e[1], q[2] - e[2]) < 16 + R) return false;
    return !(Math.abs(q[0]) < 26 && Math.abs(q[1] - mo[1]) < 10 + R && q[2] > mo[2] - 20);
  };
  let h = 2166136261; for (const c of id + name) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const seed = (W.seed ^ h) >>> 0;
  W.areaStates = W.areaStates || {};
  W.areaStates[id] = { seed, lesions: W.genLesions(PP.AREAS[id], PP.rng(seed), accept), gpu: null };
  UI.addSpotOption(id);
  this._lesT = -1; this.dirty = true;
  return id;
};
PP.Body.prototype.dropSpot = function (id) {
  const W = this.W, st = W.areaStates && W.areaStates[id];
  if (st && st.gpu) for (const k of ['physA', 'physB', 'film']) this.G.freeTarget(st.gpu[k]);
  if (W.areaStates) delete W.areaStates[id];
  delete PP.AREAS[id]; delete this.anchors[id];
  this.order = this.order.filter((x) => x !== id);
  PP.main.UI.removeSpotOption(id);
  this._lesT = -1;
};

/* ---------------- blemish data for every area ---------------- */
PP.Body.prototype.areaLesions = function (id) {
  const W = this.W;
  if (id === W.areaId) return W.lesions;
  const st = W.areaStates && W.areaStates[id];
  return st ? st.lesions : [];
};
PP.Body.prototype.uploadLesions = function () {
  const d = this.lesData, ua = this.ua; d.fill(0);
  let row = 0;
  this.order.forEach((id, ai) => {
    const a = this.anchors[id], Ls = this.areaLesions(id).slice(0, 64);
    ua.p.set([a.p[0], a.p[1], a.p[2], PP.AREAS[id].size / 2], ai * 4);
    ua.t.set([a.t[0], a.t[1], a.t[2], row], ai * 4);
    ua.b.set([a.b[0], a.b[1], a.b[2], Ls.length], ai * 4);
    ua.n.set([a.n[0], a.n[1], a.n[2], 0], ai * 4);
    for (const L of Ls) {
      const T = L.T, o = row * 12, vis = T.vis;
      const f = L.queue && L.queue.length ? L.fill() : 1;
      const open = L.open && L.open.r > 0 && (L.popped || L.open.kind === 'needle' || L.open.kind === 'tear') ? Math.min(L.ropen ? L.ropen() : L.open.r, L.R * 0.6) : 0;
      const cr = L.popped || L.crater > 0 ? Math.max(open, L.R * 0.3 * Math.min(1, (L.crater || 0) + 0.4)) : open * 0.6;
      let headR = 0;
      if ((vis === 7 || vis === 8 || vis === 1 || vis === 2 || vis === 6) && !L.popped && f > 0.3) headR = vis === 1 || vis === 2 ? L.R * 0.35 : vis === 6 ? L.R * 0.6 : L.R * 0.5;
      if ((vis === 9 || vis === 10) && !L.popped) headR = L.R * (0.12 + 0.2 * (L.pointing || 0)) * (L.pointing > 0.3 ? 1 : 0);
      const cc = L.type === 'pustule' || L.type === 'giant' || L.type === 'furuncle' || L.type === 'carbuncle' || L.type === 'ingrown' ? L.pusCol : vis === 6 ? PP.hex2lin('#f4efe2') : PP.hex2lin('#f0ead8');
      const dark = vis === 0 || vis === 3 || vis === 4 ? 1 : vis === 5 ? 0.35 : 0;
      d.set([L.x + L.ox, L.y + L.oy, L.R, Math.max(0, L.domeH()),
        headR, (L.inflam || 0) + (L.deep || 0) * 0.4 + (L.irrit || 0) * 0.5, dark, cr,
        cc[0], cc[1], cc[2], L.hematoma || 0], o);
      row++;
    }
  });
  const gl = this.gl;
  gl.bindTexture(gl.TEXTURE_2D, this.lesTex.t);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 3, 1024, gl.RGBA, gl.FLOAT, d);
};

/* ---------------- draw ---------------- */
PP.Body.prototype.render = function () {
  if (!this.ready) return;
  const gl = this.gl, G = this.G, R = this.R, W = this.W, P = this.P;
  this.ensureTargets();
  this.matrices();
  if (W.time - this._lesT > 0.4 || this._lesT < 0) { this.uploadLesions(); this._lesT = W.time; }
  const cw = R.cw, ch = R.ch;
  // key-light shadow map
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadow.fb); gl.viewport(0, 0, 1024, 1024);
  gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
  gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.5, 2.0);
  gl.useProgram(P.shadow.p); gl.uniformMatrix4fv(P.shadow.u.uLVP, false, this.LVP);
  gl.bindVertexArray(this.vao); gl.drawElements(gl.TRIANGLES, this.nBody, gl.UNSIGNED_SHORT, 0);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  // studio backdrop + bust
  gl.bindFramebuffer(gl.FRAMEBUFFER, this.ms ? this.ms.fb : this.rt.fb); gl.viewport(0, 0, cw, ch);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(P.bg.p); gl.uniform1f(P.bg.u.uAspect, cw / ch); G.drawFS();
  gl.enable(gl.DEPTH_TEST);
  const S = P.body; gl.useProgram(S.p);
  const face = this.face, set = face, ua = this.ua;
  gl.uniformMatrix4fv(S.u.uVP, false, this.VP); gl.uniformMatrix4fv(S.u.uLVP, false, this.LVP);
  gl.uniformMatrix3fv(S.u.uVR, false, this.u9); gl.uniform3fv(S.u.uEyePos, this.eye); gl.uniform2f(S.u.uRes, cw, ch);
  G.bindTex(0, set.chromo, S.u.uChromo); G.bindTex(1, set.nrm, S.u.uNrm); G.bindTex(2, set.detail, S.u.uDetail);
  G.bindTex(3, R.envAtlas, S.u.uEnvP); G.bindTex(4, this.lesTex, S.u.uLes);
  const cur = this.order.indexOf(W.areaId);
  const live = cur >= 0 && R.physA && R.film && !W.switching;
  G.bindTex(5, live ? R.physA.texs[0] : R.dummy, S.u.uPhysC); G.bindTex(6, live ? R.film.texs[0] : R.dummy, S.u.uFilmC);
  gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, this.shadow.t); gl.uniform1i(S.u.uShadow, 7);
  gl.uniform1f(S.u.uTile, set.meta.tile_mm); gl.uniform1f(S.u.uHmm, set.meta.height_mm * 1.35); gl.uniform1f(S.u.uYTop, this.meta.bbox[1][1]);
  gl.uniform1f(S.u.uDetK, 0.55 + 0.09 * W.toneIdx);
  gl.uniform3fv(S.u.uTone, W.tone.mean); gl.uniform3fv(S.u.uToneA, W.tone.amp);
  gl.uniform3fv(S.u.uVM, W.manifest.basis.melanin); gl.uniform3fv(S.u.uVH, W.manifest.basis.hemoglobin); gl.uniform3fv(S.u.uVS, W.manifest.basis.shade);
  gl.uniform3fv(S.u.uSH, R.sh); gl.uniform1f(S.u.uYaw, W.envYaw); gl.uniform1f(S.u.uExposure, W.exposure); gl.uniform1f(S.u.uRing, W.S.ring ? 1 : 0);
  gl.uniform3fv(S.u.uKey, W.keyDir);
  gl.uniform4fv(S.u.uAP, ua.p); gl.uniform4fv(S.u.uAT, ua.t); gl.uniform4fv(S.u.uAB, ua.b); gl.uniform4fv(S.u.uAN, ua.n);
  // hovering skin that isn't part of an area yet: outline where its close-up would be (an extra, empty slot)
  let nA = this.order.length, hov = this.hover;
  const pv = this.preview;
  if (pv && nA < 16) {
    ua.p.set([pv.p[0], pv.p[1], pv.p[2], pv.size / 2], nA * 4); ua.t.set([pv.t[0], pv.t[1], pv.t[2], 0], nA * 4);
    ua.b.set([pv.b[0], pv.b[1], pv.b[2], 0], nA * 4); ua.n.set([pv.n[0], pv.n[1], pv.n[2], 0], nA * 4);
    hov = nA; nA++;
    gl.uniform4fv(S.u.uAP, ua.p); gl.uniform4fv(S.u.uAT, ua.t); gl.uniform4fv(S.u.uAB, ua.b); gl.uniform4fv(S.u.uAN, ua.n);
  }
  gl.uniform1i(S.u.uNA, nA); gl.uniform1i(S.u.uHover, hov); gl.uniform1i(S.u.uCur, live ? cur : -1);
  gl.uniform1f(S.u.uShowAll, this.showAll); gl.uniform1f(S.u.uBloodOn, W.S.blood ? 1 : 0);
  const M = this.meta;
  gl.uniform3fv(S.u.uNose, M.nose); gl.uniform3fv(S.u.uMouth, M.mouth); gl.uniform3fv(S.u.uEyeL, M.eyes[0]); gl.uniform3fv(S.u.uEyeR, M.eyes[1]); gl.uniform3fv(S.u.uHead, M.headCenter);
  gl.bindVertexArray(this.vao);
  // the bust is an open shell (cropped at the chest, back and arms): never show its inside
  gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
  gl.uniform1i(S.u.uIsEye, 0); gl.drawElements(gl.TRIANGLES, this.nBody, gl.UNSIGNED_SHORT, 0);
  gl.uniform1i(S.u.uIsEye, 1); gl.drawElements(gl.TRIANGLES, this.nEye, gl.UNSIGNED_SHORT, this.eyeStart * 2);
  gl.disable(gl.CULL_FACE); gl.disable(gl.DEPTH_TEST);
  if (this.ms) {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.ms.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.rt.fb);
    gl.blitFramebuffer(0, 0, cw, ch, 0, 0, cw, ch, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  this.dirty = false;
};
// crossfade: blend the body image over the macro composite (called by the renderer before its post pass)
PP.Body.prototype.blendInto = function () {
  const gl = this.gl, R = this.R, P = this.P;
  this.render();
  gl.bindFramebuffer(gl.FRAMEBUFFER, R.rt.comp.fb); gl.viewport(0, 0, R.w, R.h);
  gl.enable(gl.BLEND); gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA); gl.blendColor(0, 0, 0, this.fade);
  gl.useProgram(P.copy.p); this.G.bindTex(0, this.rt.texs[0], P.copy.u.uT); this.G.drawFS();
  gl.disable(gl.BLEND);
};

/* ---------------- transitions ---------------- */
PP.Body.prototype.syncMacro = function (centred) {
  // while both views are on screen the macro camera shows the same millimetres per pixel as the body camera
  const W = this.W, C = W.cam, w = this.widthAt(this.cam.dist);
  C.zoom = C.tz = W.area.view / w; C.vw = w; C.vh = (w * C.ch) / C.cw;
  if (centred) { C.x = C.tx = 0; C.y = C.ty = 0; }
  C.vxp = C.vyp = 0;
};
PP.Body.prototype.enter = async function () {
  if (this.mode !== 'macro') return;
  const W = this.W, UI = PP.main.UI;
  if (!this.ready) {
    if (!this._waitToast) { this._waitToast = 1; UI.toast('', 'Loading the face…', ''); }
    await this.load(); if (!this.ready) return;
  }
  const C = W.cam, id = W.areaId, a = this.anchors[id];
  if (!a) return;
  W.tools.up(); W.tools.ptr.down = false; UI.pan = null;
  W.ensureAreas();
  const v = this.viewOf(a), M = PP.M4;
  this.cam = { p: M.add(M.add(a.p, M.scale(a.t, C.x)), M.scale(a.b, C.y)), yaw: v.yaw, pitch: v.pitch, dist: this.distW(C.vw) };
  this.matrices();
  this.tween(this.overview(id), 1.15, 'out');
  this.mode = 'entering'; this.fade = 0; this.t = 0; this._lesT = -1; this.showAll = 1.6; this.wheelLock = true; this.lastWheel = performance.now();
  this.R.hideDrops = true;
  UI.setBodyMode(true);
};
PP.Body.prototype.dive = function (id) {
  if (!this.anchors[id] || this.mode === 'diving' || this.mode === 'leaving') return;
  const a = this.anchors[id], v = this.viewOf(a);
  this.diveId = id; this.areaReady = false;
  this.tween({ p: a.p.slice(), yaw: v.yaw, pitch: v.pitch, dist: this.distW(PP.AREAS[id].size) }, 0.8, 'inout');
  this.mode = 'diving'; this.hover = -1; this.preview = null; PP.main.UI.bodyLabel(null);
  const go = id === this.W.areaId ? Promise.resolve() : PP.main.switchArea(id);
  go.then(() => { this.areaReady = true; this._lesT = -1; });
};
PP.Body.prototype.update = function (dt) {
  if (this.mode === 'macro') return false;
  if (this.freeze) { const d = this.dirty; this.dirty = false; return d; }
  this.t = (this.t || 0) + dt;
  let moved = this.ease(dt);
  if (this.showAll > 0) { this.showAll = Math.max(0, this.showAll - dt * 0.6); moved = true; }
  if (this.mode === 'entering') {
    this.fade = PP.clamp(this.t / 0.42, 0, 1); this.fade = this.fade * this.fade * (3 - 2 * this.fade);
    this.syncMacro(false);
    if (this.t >= 0.42) { this.mode = 'body'; this.fade = 1; }
    moved = true;
  } else if (this.mode === 'diving') {
    if (!this.tw && this.areaReady) {
      this.mode = 'leaving'; this.t = 0;
      const a = this.anchors[this.diveId], v = this.viewOf(a);
      this.tween({ p: a.p.slice(), yaw: v.yaw, pitch: v.pitch, dist: this.distW(PP.AREAS[this.diveId].size / 1.45) }, 0.6, 'out');
      this.syncMacro(true);
    }
    moved = true;
  } else if (this.mode === 'leaving') {
    this.fade = 1 - PP.clamp(this.t / 0.4, 0, 1); this.fade = this.fade * this.fade * (3 - 2 * this.fade);
    this.syncMacro(true);
    if (this.t >= 0.4) this.exitToMacro();
    moved = true;
  }
  if (moved) this.dirty = true;
  return moved;
};
PP.Body.prototype.exitToMacro = function () {
  const W = this.W, C = W.cam;
  this.mode = 'macro'; this.fade = 0; this.tw = null;
  C.tz = C.zoom; C.tx = C.x; C.ty = C.y; C.vxp = C.vyp = 0;
  this.R.hideDrops = false; this.R.presentTex = null;
  W.activeUntil = W.time + 1;
  PP.main.UI.setBodyMode(false);
};
// jump straight into the body view (tests / screenshots)
PP.Body.prototype.jump = async function (view) {
  await this.load();
  this.W.ensureAreas();
  this.cam = this.copyCam(view); this.tgt = this.copyCam(view); this.tw = null;
  this.mode = 'body'; this.fade = 1; this.t = 1; this._lesT = -1; this.showAll = 0;
  this.R.hideDrops = true; PP.main.UI.setBodyMode(true);
};

/* ---------------- input (body view) ---------------- */
PP.Body.prototype.interactive = function () { return this.mode === 'body' || this.mode === 'entering'; };
PP.Body.prototype.down = function (e) {
  this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (this.ptrs.size === 2) {
    const [a, b] = [...this.ptrs.values()];
    this.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), dist0: this.tgt.dist, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    this.drag = null; return;
  }
  // left-drag moves the body; right/middle-drag or Shift-drag turns it
  this.drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0, rot: (e.button === 1 || e.button === 2 || e.shiftKey) && !PP.main.UI.space };
  if (this.interactive() && this.tw) { this.tgt = this.copyCam(this.cam); this.tw = null; if (this.mode === 'entering') { this.mode = 'body'; this.fade = 1; } }
};
PP.Body.prototype.move = function (e) {
  const pt = this.ptrs.get(e.pointerId); if (pt) { pt.x = e.clientX; pt.y = e.clientY; }
  if (!this.interactive()) return;
  if (this.pinch && this.ptrs.size === 2) {
    const [a, b] = [...this.ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    // two fingers: pinch zooms, moving them together turns the body
    this.turn(mx - this.pinch.mx, my - this.pinch.my); this.pinch.mx = mx; this.pinch.my = my;
    this.tgt.dist = PP.clamp(this.pinch.dist0 * (this.pinch.d0 / Math.max(d, 1)), this.distH(30), this.distH(1100));
    this.checkDive(mx, my);
    return;
  }
  const D = this.drag;
  if (D) {
    const dx = e.clientX - D.x, dy = e.clientY - D.y; D.x = e.clientX; D.y = e.clientY; D.moved += Math.abs(dx) + Math.abs(dy);
    const t = this.tgt;
    if (!D.rot) {
      const r = this.R.canvas.getBoundingClientRect(), mmpx = this.widthAt(t.dist) / r.width, B = this.basis, M = PP.M4;
      t.p = M.add(t.p, M.add(M.scale(B.x, -dx * mmpx), M.scale(B.y, dy * mmpx)));
      const bb = this.meta.bbox;
      for (let k = 0; k < 3; k++) t.p[k] = PP.clamp(t.p[k], bb[0][k] - 60, bb[1][k] + 60);
    } else this.turn(dx, dy);
    this.R.canvas.classList.add('grabbing');
    if (this.hover >= 0) { this.hover = -1; PP.main.UI.bodyLabel(null); }
    return;
  }
  this.hoverAt(e.clientX, e.clientY);
};
PP.Body.prototype.turn = function (dx, dy) {
  if (!this.interactive()) return;
  if (this.tw) { this.tgt = this.copyCam(this.cam); this.tw = null; if (this.mode === 'entering') { this.mode = 'body'; this.fade = 1; } }
  this.tgt.yaw -= dx * 0.0062; this.tgt.pitch = PP.clamp(this.tgt.pitch + dy * 0.0055, -0.45, 1.3);
};
PP.Body.prototype.up = function (e) {
  this.ptrs.delete(e.pointerId);
  if (this.pinch) { if (this.ptrs.size < 2) this.pinch = null; return; }
  const D = this.drag; this.drag = null;
  this.R.canvas.classList.remove('grabbing');
  if (D && D.moved < 6 && this.interactive()) {
    const h = this.pick(e.clientX, e.clientY);
    if (h && h.area) this.dive(h.area);
    else if (h) { const id = this.makeSpot(this.spotFor(h)); if (id) this.dive(id); }
  }
};
PP.Body.prototype.hoverAt = function (sx, sy) {
  const now = performance.now();
  if (now - (this._hovT || 0) < 45) return;
  this._hovT = now;
  const h = this.pick(sx, sy), id = h && h.area;
  const idx = id ? this.order.indexOf(id) : -1;
  const UI = PP.main.UI;
  let pv = null;
  if (id) { const n = this.areaLesions(id).length; UI.bodyLabel({ x: sx, y: sy, title: PP.AREAS[id].name, sub: n + ' blemish' + (n === 1 ? '' : 'es') + ' · click to zoom in' }); }
  else if (h) {
    const f = this.spotFor(h);
    if (f.bad) UI.bodyLabel({ x: sx, y: sy, title: f.bad === 'eye' ? 'Eye' : 'Lips', sub: 'no close-up here' });
    else { pv = f; UI.bodyLabel({ x: sx, y: sy, title: f.name, sub: 'click or zoom in for a close-up' }); }
  } else UI.bodyLabel(null);
  const P0 = this.preview;
  if (idx !== this.hover || !!pv !== !!P0 || (pv && P0 && Math.hypot(pv.p[0] - P0.p[0], pv.p[1] - P0.p[1], pv.p[2] - P0.p[2]) > 0.5)) this.dirty = true;
  this.hover = idx; this.preview = pv;
};
// the scroll gesture that brought us out of the macro view must pause (250 ms between input events)
// before scrolling out moves the face camera, so a flick or trackpad momentum stops at the face
PP.Body.prototype.wheel = function (e) {
  const ts = e.timeStamp || performance.now();
  if (this.wheelLock && ts - (this.lastWheel || 0) > 250) this.wheelLock = false;
  this.lastWheel = ts;
  const k = Math.exp(e.deltaY * 0.0016);
  if (this.wheelLock && k > 1) return;
  this.zoomAt(e.clientX, e.clientY, k);
};
PP.Body.prototype.zoomAt = function (sx, sy, k) {
  if (!this.interactive()) return;
  if (this.tw) { this.tgt = this.copyCam(this.cam); this.tw = null; if (this.mode === 'entering') { this.mode = 'body'; this.fade = 1; } }
  const t = this.tgt, M = PP.M4;
  const nd = PP.clamp(t.dist * k, this.distH(30), this.distH(1100));
  const f = 1 - nd / t.dist;
  if (f > 0) { const h = this.pick(sx, sy); if (h) t.p = M.lerp3(t.p, h.p, f); }
  else if (f < 0) { const ov = this.overview(this.W.areaId); t.p = M.lerp3(t.p, ov.p, Math.min(1, -f * 0.8)); }
  t.dist = nd;
  if (k < 1) this.checkDive(sx, sy);
};
// zoomed in far enough over a marked area: dive into its macro patch
PP.Body.prototype.checkDive = function (sx, sy) {
  const h = this.pick(sx, sy); if (!h) return;
  const w = Math.min(this.widthAt(this.tgt.dist), this.widthAt(this.tgt.dist) / this.aspect());
  if (h.area) { if (w < PP.AREAS[h.area].size * 1.35) this.dive(h.area); return; }
  // anywhere else on the skin: open a close-up there once the view is about its size
  const f = this.spotFor(h);
  if (!f.bad && w < f.size * 1.35) { const id = this.makeSpot(f); if (id) this.dive(id); }
};
