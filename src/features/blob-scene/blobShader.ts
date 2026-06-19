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

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec3 vObjectPosition;
varying float vDisplacement;

${simplexNoise3d}

float blobFbm(vec3 point) {
  float time = uTime * uNoiseSpeed;
  vec3 domainDrift = vec3(
    snoise(point * 0.42 + vec3(time * 0.23, -time * 0.17, time * 0.11)),
    snoise(point * 0.36 + vec3(-time * 0.13, time * 0.21, time * 0.16)),
    snoise(point * 0.31 + vec3(time * 0.15, time * 0.09, -time * 0.19))
  ) * 0.18;
  vec3 warpedPoint = point + domainDrift;
  float firstLayer = snoise(warpedPoint * 0.8 + vec3(time * 0.16, time, time * 0.35));
  float secondLayer = snoise(warpedPoint * 2.5 + vec3(time * 0.7, -time * 0.29, -time * 0.45));
  return firstLayer * 0.72 + secondLayer * 0.28;
}

void main() {
  vec3 unitNormal = normalize(normal);
  float displacement = blobFbm(position);
  vec3 displacedPosition = position + unitNormal * displacement * uAmplitude;

  vec4 worldPosition = modelMatrix * vec4(displacedPosition, 1.0);
  vWorldPosition = worldPosition.xyz;
  vObjectPosition = displacedPosition;
  vNormal = normalize(mat3(modelMatrix) * unitNormal);
  vDisplacement = displacement;

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
uniform vec3 uViewPosition;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec3 vObjectPosition;
varying float vDisplacement;

${simplexNoise3d}

void main() {
  vec3 normalDirection = normalize(vNormal);
  vec3 viewDirection = normalize(uViewPosition - vWorldPosition);
  float time = uTime * 0.18;
  float fresnel = pow(1.0 - max(dot(viewDirection, normalDirection), 0.0), uFresnelPower);
  float innerLarge = snoise(vObjectPosition * 1.15 + vec3(time * 0.9, -time * 0.42, time * 0.31));
  float innerSmall = snoise(vObjectPosition * 3.4 + vec3(-time * 0.33, time * 0.74, -time * 0.52));
  float innerFlow = innerLarge * 0.7 + innerSmall * 0.3;
  float surfaceShade = 0.44 + vDisplacement * 0.1 + innerFlow * 0.085 * uInternalFlow;
  float coreGlow = smoothstep(-0.35, 0.72, innerFlow) * 0.16;

  vec3 innerColor = uBaseColor * (surfaceShade + coreGlow);
  vec3 rimColor = uEdgeColor * fresnel * (2.05 * uEdgeBoost);
  vec3 glowColor = innerColor + rimColor;

  gl_FragColor = vec4(glowColor, 1.0);
}
`;
