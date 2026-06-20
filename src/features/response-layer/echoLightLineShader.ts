export const echoLightLineVertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const echoLightLineFragmentShader = `
precision highp float;

uniform float uTime;
uniform float uPulse;
uniform float uTone;
uniform float uAspect;

varying vec2 vUv;

float softBand(float value, float width) {
  return 1.0 - smoothstep(0.0, width, abs(value));
}

float softRange(float value, float radius, float feather) {
  return 1.0 - smoothstep(radius, radius + feather, abs(value));
}

float hash(vec2 point) {
  return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 point) {
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

void main() {
  vec2 point = vec2(vUv.x - 0.5, vUv.y - 0.5);
  float x = abs(point.x);
  float y = abs(point.y);
  float pulse = smoothstep(0.0, 1.0, uPulse);
  float calm = 0.62 + sin(uTime * 1.05) * 0.08;
  float horizontalBody = softRange(point.x, 0.42, 0.08);
  float horizontalCore = softRange(point.x, 0.28, 0.16);

  float coreLine = softBand(point.y, 0.018) * horizontalBody;
  float nearGlow = softBand(point.y, 0.09) * horizontalBody * 0.56;
  float wideGlow = softBand(point.y, 0.22) * horizontalCore * 0.24;
  float centerCore = exp(-length(point * vec2(6.2, 46.0)) * 2.7);
  float centerBloom = exp(-length(point * vec2(3.2, 16.0)) * 2.2);

  float flowNoise = noise(vec2(point.x * 8.0 - uTime * 0.18, point.y * 30.0 + uTime * 0.14));
  float fineNoise = noise(vec2(point.x * 24.0 + uTime * 0.1, point.y * 58.0 - uTime * 0.22));
  float wave = sin((point.x + flowNoise * 0.06) * 19.0 - uTime * 1.35) * 0.5 + 0.5;
  float stream = smoothstep(0.72, 0.98, wave) * softBand(point.y, 0.035) * horizontalBody;

  float reveal = smoothstep(0.02, 0.28, pulse) * (1.0 - smoothstep(0.86, 1.0, pulse));
  float travelLeft = 1.0 - smoothstep(0.0, 0.08, abs((vUv.x - 0.5) + pulse * 0.46));
  float travelRight = 1.0 - smoothstep(0.0, 0.08, abs((vUv.x - 0.5) - pulse * 0.46));
  float travel = (travelLeft + travelRight) * reveal * softBand(point.y, 0.045);

  float energy = coreLine * (0.5 + calm * 0.18);
  energy += nearGlow * (0.16 + stream * 0.18);
  energy += wideGlow * (0.025 + fineNoise * 0.026);
  energy += centerCore * (0.36 + pulse * 0.56);
  energy += centerBloom * (0.08 + pulse * 0.28);
  energy += stream * 0.34;
  energy += travel * 0.62;

  vec3 blue = vec3(0.18, 0.48, 1.0);
  vec3 cyan = vec3(0.66, 0.9, 1.0);
  vec3 whiteBlue = vec3(0.92, 0.98, 1.0);
  vec3 errorRed = vec3(1.0, 0.54, 0.48);
  vec3 errorSoft = vec3(1.0, 0.82, 0.74);

  vec3 calmColor = blue * 0.42 + cyan * 0.92 + whiteBlue * (centerCore * 0.42 + travel * 0.24);
  vec3 errorColor = errorRed * 0.72 + errorSoft * (centerCore * 0.34 + travel * 0.18);
  vec3 color = mix(calmColor, errorColor, step(0.5, uTone));

  float alpha = clamp(energy * mix(0.5, 0.62, step(0.5, uTone)), 0.0, 0.82);
  alpha *= horizontalBody * softRange(point.y, 0.22, 0.08);

  gl_FragColor = vec4(color * (0.45 + energy * 0.9), alpha);
}
`;
