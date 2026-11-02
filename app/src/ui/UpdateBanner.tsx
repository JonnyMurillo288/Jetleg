import { useUpdate } from '../update';

/** Shown on every page once a newer version of the app is waiting (update.ts). */
export function UpdateBanner() {
  const { ready, update } = useUpdate();
  if (!ready) return null;
  return (
    <div className="updatebanner" role="status">
      <span>A new version of JetLeg is ready.</span>
      <button className="primary" onClick={update}>Update</button>
    </div>
  );
}
