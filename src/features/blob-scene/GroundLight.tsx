export function GroundLight() {
  return (
    <mesh position={[0, -1.72, -0.16]} rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[1.2, 96]} />
      <meshBasicMaterial color="#001166" transparent opacity={0.16} depthWrite={false} />
    </mesh>
  );
}
