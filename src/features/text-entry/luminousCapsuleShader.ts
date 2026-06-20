export const luminousCapsuleVertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const luminousCapsuleFragmentShader = `
precision highp float;

uniform float uTime;
uniform float uReveal;
uniform float uFocus;
uniform float uAspect;
uniform float uHasMessage;

varying vec2 vUv;

const float PI = 3.14159265359;

float hash(vec2 point) {
  return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  vec2 curve = local * local * (3.0 - 2.0 * local);

  float bottomLeft = hash(cell);
  float bottomRight = hash(cell + vec2(1.0, 0.0));
  float topLeft = hash(cell + vec2(0.0, 1.0));
  float topRight = hash(cell + vec2(1.0, 1.0));

  float lower = mix(bottomLeft, bottomRight, curve.x);
  float upper = mix(topLeft, topRight, curve.x);
  return mix(lower, upper, curve.y);
}

float capsuleDistance(vec2 point, vec2 halfSize, float radius) {
  vec2 capsulePoint = vec2(abs(point.x) - halfSize.x + radius, abs(point.y) - halfSize.y + radius);
  return length(max(capsulePoint, 0.0)) + min(max(capsulePoint.x, capsulePoint.y), 0.0) - radius;
}

void main() {
  vec2 point = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  float reveal = smoothstep(0.0, 1.0, uReveal);
  float focus = smoothstep(0.0, 1.0, uFocus);
  float canvasHalfWidth = uAspect * 0.5;
  float halfWidth = canvasHalfWidth * 0.865;
  float halfHeight = 0.185;
  float radius = halfHeight;
  float capsule = capsuleDistance(point, vec2(halfWidth, halfHeight), radius);
  float body = 1.0 - smoothstep(-0.018, 0.016, capsule);
  float rim = 1.0 - smoothstep(0.002, 0.024, abs(capsule));
  float innerRim = 1.0 - smoothstep(0.018, 0.105, abs(capsule + 0.03));
  float nearGlow = 1.0 - smoothstep(0.0, 0.09, capsule);
  float wideGlow = 1.0 - smoothstep(0.02, 0.28, capsule);

  float endpointX = halfWidth - radius;
  float leftCore = exp(-length((point - vec2(-endpointX, 0.0)) * vec2(3.8, 13.0)) * 3.2);
  float rightCore = exp(-length((point - vec2(endpointX, 0.0)) * vec2(3.8, 13.0)) * 3.2);
  float endpointEnergy = leftCore + rightCore * (1.0 + uHasMessage * 0.55);

  float normalizedX = abs(point.x) / max(halfWidth, 0.001);
  float edgeDistance = abs(abs(point.x) - halfWidth);
  float edgeAnchor = exp(-edgeDistance * 3.25);
  float outwardMask = smoothstep(halfWidth - radius * 0.35, canvasHalfWidth, abs(point.x));
  float inwardMask = smoothstep(0.96, 0.72, normalizedX);
  float horizontalBeam = exp(-abs(point.y) * 38.0) * edgeAnchor * (0.62 + outwardMask * 0.46 + inwardMask * 0.18);
  float sideFlare = exp(-abs(point.y) * 44.0) * edgeAnchor * outwardMask;
  float mistMask = 1.0 - smoothstep(0.015, 0.22, capsule);
  float verticalMist = exp(-abs(point.y) * 12.0) * mistMask;
  float flowNoise = valueNoise(vec2(point.x * 4.2 + uTime * 0.18, point.y * 24.0 - uTime * 0.28));
  float fineNoise = valueNoise(vec2(point.x * 18.0 - uTime * 0.08, point.y * 42.0 + uTime * 0.22));
  float travelingWave = sin(point.x * 7.4 - uTime * 1.15 + flowNoise * 2.2) * 0.5 + 0.5;
  float counterWave = sin(point.x * -11.0 - uTime * 0.72 + fineNoise * 1.7) * 0.5 + 0.5;
  float streamBand = smoothstep(0.36, 0.92, travelingWave) * exp(-abs(point.y) * 18.0);
  float counterBand = smoothstep(0.58, 0.98, counterWave) * exp(-abs(point.y + 0.035) * 26.0);
  float flow = mix(flowNoise, fineNoise, 0.35);
  float animatedFlow = clamp(flow * 0.72 + streamBand * 0.2 + counterBand * 0.14, 0.0, 1.0);
  float capCenterX = max(endpointX, 0.001);
  float straightProgress = (point.x + capCenterX) / max(capCenterX * 2.0, 0.001);
  float rightCapProgress = 0.5 + (atan(-point.y, point.x - capCenterX) + PI * 0.5) / PI * 0.25;
  float leftCapProgress = 0.75 + (atan(point.y, point.x + capCenterX) + PI * 0.5) / PI * 0.25;
  float topProgress = straightProgress * 0.5;
  float bottomProgress = 0.75 + (1.0 - straightProgress) * 0.25;
  float rightCapMask = step(capCenterX, point.x);
  float leftCapMask = step(point.x, -capCenterX);
  float straightMask = 1.0 - max(leftCapMask, rightCapMask);
  float edgeProgress = straightMask * mix(bottomProgress, topProgress, step(0.0, point.y));
  edgeProgress += rightCapMask * rightCapProgress;
  edgeProgress += leftCapMask * leftCapProgress;
  float edgePulseA = pow(sin(fract(edgeProgress - uTime * 0.18) * PI * 2.0) * 0.5 + 0.5, 7.0);
  float edgePulseB = pow(sin(fract(edgeProgress * 1.7 + uTime * 0.12) * PI * 2.0) * 0.5 + 0.5, 9.0);
  float borderFlow = rim * (edgePulseA * 0.5 + edgePulseB * 0.32) * (0.45 + focus * 0.55);

  vec3 violet = vec3(0.62, 0.36, 1.0);
  vec3 paleViolet = vec3(0.86, 0.72, 1.0);
  vec3 whiteHot = vec3(1.0, 0.96, 1.0);
  vec3 deepViolet = vec3(0.20, 0.06, 0.42);

  float idleFloor = 0.07;
  float energy = idleFloor + reveal * 0.93;
  float focusBoost = 1.0 + focus * 0.36;
  float movingMist = verticalMist * (0.09 + animatedFlow * 0.24) * energy;
  float shell = rim * (0.58 + animatedFlow * 0.28 + streamBand * 0.12) * energy * focusBoost;
  shell += borderFlow * energy;
  float innerShell = innerRim * (0.14 + counterBand * 0.08) * energy;
  float bodyGlow = body * (0.045 + focus * 0.03) * energy;
  float capsuleHalo = nearGlow * (0.18 + animatedFlow * 0.07) * energy;
  float outerHalo = wideGlow * (0.04 + focus * 0.03) * energy;
  float beam = horizontalBeam * (0.18 + streamBand * 0.1 + focus * 0.12) * energy;
  float flare = sideFlare * (0.19 + focus * 0.08) * reveal;
  float coreGlow = endpointEnergy * (0.86 + focus * 0.44 + uHasMessage * 0.18) * energy;

  vec3 color = deepViolet * movingMist;
  color += violet * (bodyGlow + innerShell + movingMist * 0.75 + outerHalo);
  color += paleViolet * (beam + flare + shell * 0.62 + capsuleHalo);
  color += whiteHot * (shell * 0.64 + coreGlow);

  float alpha = movingMist + beam + flare + shell + coreGlow + body * 0.075 * energy + capsuleHalo + outerHalo;
  alpha *= smoothstep(0.01, 0.11, energy);
  alpha = clamp(alpha, 0.0, 1.0);

  gl_FragColor = vec4(color, alpha);
}
`;
