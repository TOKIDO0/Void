import { Color, Vector3 } from "three";

export const BLOB_SHADER_DEFAULTS = {
  amplitude: 0.28,
  fresnelPower: 3.15,
  primaryColor: "#0A0AFF",
  edgeColor: "#00CFFF"
};

export const createBlobUniforms = () => ({
  uTime: { value: 0 },
  uAmplitude: { value: BLOB_SHADER_DEFAULTS.amplitude },
  uNoiseSpeed: { value: 0.16 },
  uBaseColor: { value: new Color(BLOB_SHADER_DEFAULTS.primaryColor) },
  uEdgeColor: { value: new Color(BLOB_SHADER_DEFAULTS.edgeColor) },
  uFresnelPower: { value: BLOB_SHADER_DEFAULTS.fresnelPower },
  uEdgeBoost: { value: 1 },
  uInternalFlow: { value: 1 },
  uIrregularity: { value: 1 },
  uTransitionEnergy: { value: 0 },
  uExpandedResponse: { value: 0 },
  uExpandedResponseClosing: { value: 0 },
  uThinkingModePulseProgress: { value: 1 },
  uThinkingModePulseStrength: { value: 0 },
  uThinkingModePulseDirection: { value: 1 },
  uViewPosition: { value: new Vector3(0, 0, 5) }
});

const simplexNoise3d = `
vec4 permute(vec4 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

vec4 taylorInvSqrt(vec4 r) {
  return 1.79284291400159 - 0.85373472095314 * r;
}

float snoise(vec3 v) {
  const vec2 c = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 d = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i = floor(v + dot(v, c.yyy));
  vec3 x0 = v - i + dot(i, c.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + c.xxx;
  vec3 x2 = x0 - i2 + c.yyy;
  vec3 x3 = x0 - d.yyy;

  i = mod(i, 289.0);
  vec4 p = permute(
    permute(
      permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)
    ) + i.x + vec4(0.0, i1.x, i2.x, 1.0)
  );

  float n_ = 0.142857142857;
  vec3 ns = n_ * d.wyz - d.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

export const blobVertexShader = `
uniform float uTime;
uniform float uAmplitude;
uniform float uNoiseSpeed;
uniform float uIrregularity;
uniform float uTransitionEnergy;
uniform float uExpandedResponse;
uniform float uExpandedResponseClosing;
uniform float uThinkingModePulseProgress;
uniform float uThinkingModePulseStrength;
uniform float uThinkingModePulseDirection;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec3 vObjectPosition;
varying float vDisplacement;
varying float vRingMask;
varying float vInnerEdge;
varying float vInkMask;
varying float vThinkingPulseMask;

${simplexNoise3d}

float blobFbm(vec3 point) {
  float time = uTime * uNoiseSpeed;
  vec3 domainDrift = vec3(
    snoise(point * 0.42 + vec3(time * 0.23, -time * 0.17, time * 0.11)),
    snoise(point * 0.36 + vec3(-time * 0.13, time * 0.21, time * 0.16)),
    snoise(point * 0.31 + vec3(time * 0.15, time * 0.09, -time * 0.19))
  ) * (0.18 * uIrregularity + 0.035 * uTransitionEnergy);
  vec3 warpedPoint = point + domainDrift;
  float firstLayer = snoise(warpedPoint * 0.8 + vec3(time * 0.16, time, time * 0.35));
  float secondLayer = snoise(warpedPoint * (2.5 + uTransitionEnergy * 0.16) + vec3(time * 0.7, -time * 0.29, -time * 0.45));
  return firstLayer * 0.72 + secondLayer * 0.28;
}

void main() {
  vec3 unitNormal = normalize(normal);
  float displacement = blobFbm(position);
  float expanded = smoothstep(0.0, 1.0, uExpandedResponse);
  float closing = smoothstep(0.0, 1.0, uExpandedResponseClosing);
  float radial = length(position.xy);
  float ringAngle = atan(position.y, position.x);
  float thinkingPulseNoise = snoise(vec3(position.xy * 3.1, uTime * 0.28)) * 0.028;
  float thinkingPulseFineNoise = snoise(vec3(position.xy * 6.8, -uTime * 0.21)) * 0.012;
  float thinkingPulseRadius = mix(0.02, 1.22, smoothstep(0.0, 1.0, uThinkingModePulseProgress));
  float thinkingPulseBand = 1.0 - smoothstep(0.0, 0.16, abs(radial - (thinkingPulseRadius + thinkingPulseNoise + thinkingPulseFineNoise)));
  float thinkingPulseTail = smoothstep(thinkingPulseRadius - 0.26, thinkingPulseRadius + 0.06, radial);
  float thinkingPulseMask = thinkingPulseBand * (1.0 - thinkingPulseTail) * uThinkingModePulseStrength;
  float inkNoise = snoise(vec3(position.xy * 2.15, uTime * 0.16)) * 0.08;
  float fineInkNoise = snoise(vec3(position.xy * 5.2, -uTime * 0.11)) * 0.035;
  float inkReveal = smoothstep(0.08, 0.2, expanded);
  float inkReach = mix(-0.18, 1.08, expanded) + (inkNoise + fineInkNoise) * inkReveal;
  float inkMask = smoothstep(radial - 0.2, radial + 0.18, inkReach) * inkReveal;
  float hollowStructure = smoothstep(0.18, 1.0, expanded) * (1.0 - smoothstep(0.02, 0.58, closing));
  float organicHole = snoise(vec3(cos(ringAngle) * 1.7, sin(ringAngle) * 1.7, uTime * 0.12)) * 0.055;
  float surfaceBreath = snoise(vec3(position.xy * 2.4, uTime * 0.15)) * 0.025;
  float innerRadius = mix(0.05, 0.43 + organicHole + surfaceBreath, hollowStructure);
  float ringMask = smoothstep(innerRadius - 0.07, innerRadius + 0.15, radial);
  float edgeRadiusGuard = smoothstep(0.18, 0.34, innerRadius);
  float innerRimEnergy = hollowStructure * edgeRadiusGuard * (1.0 - closing);
  float innerEdge = (1.0 - smoothstep(0.0, 0.105, abs(radial - innerRadius))) * innerRimEnergy;
  vec2 radialDirection = normalize(position.xy + vec2(0.0001));
  vec3 ringSpread = vec3(radialDirection * ringMask * hollowStructure * 0.21, 0.0);
  vec3 inwardSoftening = vec3(radialDirection * -(1.0 - ringMask) * hollowStructure * 0.045, -hollowStructure * (1.0 - ringMask) * 0.075);
  float activeAmplitude = uAmplitude * (1.0 + expanded * 0.18);
  vec3 displacedPosition = position + unitNormal * displacement * activeAmplitude + ringSpread + inwardSoftening;

  vec4 worldPosition = modelMatrix * vec4(displacedPosition, 1.0);
  vWorldPosition = worldPosition.xyz;
  vObjectPosition = displacedPosition;
  vNormal = normalize(mat3(modelMatrix) * unitNormal);
  vDisplacement = displacement;
  vRingMask = ringMask;
  vInnerEdge = innerEdge;
  vInkMask = inkMask;
  vThinkingPulseMask = thinkingPulseMask;

  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const blobFragmentShader = `
uniform float uTime;
uniform vec3 uBaseColor;
uniform vec3 uEdgeColor;
uniform float uFresnelPower;
uniform float uEdgeBoost;
uniform float uInternalFlow;
uniform float uTransitionEnergy;
uniform float uExpandedResponse;
uniform float uExpandedResponseClosing;
uniform float uThinkingModePulseProgress;
uniform float uThinkingModePulseStrength;
uniform float uThinkingModePulseDirection;
uniform vec3 uViewPosition;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec3 vObjectPosition;
varying float vDisplacement;
varying float vRingMask;
varying float vInnerEdge;
varying float vInkMask;
varying float vThinkingPulseMask;

${simplexNoise3d}

void main() {
  vec3 normalDirection = normalize(vNormal);
  vec3 viewDirection = normalize(uViewPosition - vWorldPosition);
  float expanded = smoothstep(0.0, 1.0, uExpandedResponse);
  float closing = smoothstep(0.0, 1.0, uExpandedResponseClosing);
  float hollowStructure = smoothstep(0.18, 1.0, expanded) * (1.0 - smoothstep(0.02, 0.58, closing));
  float time = uTime * (0.18 + uTransitionEnergy * 0.035);
  float fresnel = pow(1.0 - max(dot(viewDirection, normalDirection), 0.0), uFresnelPower);
  float innerLarge = snoise(vObjectPosition * 1.15 + vec3(time * 0.9, -time * 0.42, time * 0.31));
  float innerSmall = snoise(vObjectPosition * (3.4 + uTransitionEnergy * 0.22) + vec3(-time * 0.33, time * 0.74, -time * 0.52));
  float innerFlow = innerLarge * 0.7 + innerSmall * 0.3;
  float flowStrength = uInternalFlow + uTransitionEnergy * 0.16 + expanded * 0.14;
  float surfaceShade = 0.44 + vDisplacement * 0.1 + innerFlow * 0.085 * flowStrength;
  float coreGlow = smoothstep(-0.35, 0.72, innerFlow) * (0.16 + uTransitionEnergy * 0.025);

  vec3 activeBaseColor = vec3(1.0, 0.08, 0.58);
  vec3 activeEdgeColor = vec3(1.0, 0.74, 0.95);
  vec3 thinkingPulseOnColor = vec3(0.62, 1.0, 0.56);
  vec3 thinkingPulseOffColor = vec3(1.0, 0.77, 0.9);
  vec3 thinkingPulseColor = mix(thinkingPulseOffColor, thinkingPulseOnColor, uThinkingModePulseDirection);
  vec3 deepInnerColor = vec3(0.2, 0.0, 0.13);
  float inkColorMask = clamp(vInkMask, 0.0, 1.0);
  vec3 baseColor = mix(uBaseColor, activeBaseColor, inkColorMask);
  vec3 edgeColor = mix(uEdgeColor, activeEdgeColor, max(inkColorMask, expanded * 0.34));
  float hollowFade = mix(1.0, clamp(vRingMask + vInnerEdge * 0.32, 0.0, 1.0), hollowStructure);
  float innerDepth = (1.0 - vRingMask) * hollowStructure;
  float activeEdge = vInnerEdge * (1.0 - closing) * (0.78 + sin(uTime * 1.2 + innerFlow * 2.0) * 0.08);
  vec3 innerColor = mix(baseColor * (surfaceShade + coreGlow), deepInnerColor, innerDepth * 0.74);
  vec3 rimColor = edgeColor * fresnel * (2.05 * uEdgeBoost + expanded * 0.72);
  vec3 innerRimColor = activeEdgeColor * activeEdge * 1.28;
  float pulseCore = vThinkingPulseMask * (0.62 + fresnel * 0.78);
  vec3 thinkingPulseGlow = thinkingPulseColor * pulseCore * (1.18 + uEdgeBoost * 0.32);
  vec3 glowColor = innerColor + rimColor;
  glowColor += innerRimColor;
  glowColor += thinkingPulseGlow;
  glowColor *= 0.72 + hollowFade * 0.36;

  float alpha = mix(1.0, clamp(hollowFade + activeEdge * 0.22, 0.035, 1.0), hollowStructure);
  gl_FragColor = vec4(glowColor, alpha);
}
`;
