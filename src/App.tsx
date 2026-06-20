import { Agentation } from "agentation";
import { VoidStage } from "./features/void-stage/VoidStage";

export default function App() {
  return (
    <>
      <VoidStage />
      {import.meta.env.DEV ? <Agentation /> : null}
    </>
  );
}
