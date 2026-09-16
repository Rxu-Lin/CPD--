// Isolated manual regression page. Never reads or writes the user's saved draft.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js'
import Model3DStudio from '../src/Model3DStudio'
import { cacheModelFile } from '../src/model3dAssets'
import type { SavedModel3DScene } from '../src/model3dSceneStore'
import '../src/index.css'
import '../src/App.css'

export default function TestPage() {
  const [scene, setScene] = useState<SavedModel3DScene | null>(null)
  const [opened, setOpened] = useState(false)
  const [report, setReport] = useState('未开始')
  async function loadTest() {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), new THREE.MeshStandardMaterial())
    const obj = new OBJExporter().parse(mesh)
    mesh.geometry.dispose(); mesh.material.dispose()
    const source = await cacheModelFile(new Blob([obj]), 'test-sphere.obj', 'OBJ')
    setScene({ version: 2, savedAt: new Date().toISOString(), items: [{ kind: 'imported-model', name: '测试球体', color: '#ff5544', source,
      transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } }], selectedIndex: 0, viewportId: 'square', backgroundColor: '#111820', focalLength: 50,
      showProjection: false, lightEnabled: true, lightIntensity: 100, lightAzimuth: -55, lightElevation: 38, camera: { position: [3, 2, 5], up: [0, 1, 0], target: [0, 0, 0] } })
    setOpened(true)
  }
  return <div className="canvas-app" style={{ display: 'block', overflow: 'auto' }}><button onClick={() => void loadTest()}>载入 OBJ 测试模型</button><button disabled={!scene} onClick={() => setOpened(true)}>重新打开导出场景</button>
    <pre>{report}</pre>{opened && <Model3DStudio initialScene={scene} useSavedScene={false} transparentExport={new URLSearchParams(location.search).has('sketch')} onClose={() => setOpened(false)} onExport={(result) => {
      setScene(result.scene)
      setReport(JSON.stringify(result.scene.items.map((item) => ({ color: item.color, transform: item.transform, source: item.source })), null, 2))
    }} />}</div>
}
const root = createRoot(document.getElementById('root')!)
root.render(<TestPage />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
