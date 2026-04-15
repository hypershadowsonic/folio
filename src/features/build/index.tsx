import { useUIStore } from '@/stores/uiStore'
import { Builds } from './builds'
import { Dashboard as BuildDashboard } from './dashboard'
import { BuildSettings } from './settings'
import { LabTab } from './lab/LabTab'

// ─── Build shell ─────────────────────────────────────────────────────────────

export default function BuildShell() {
  const buildTab = useUIStore((s) => s.buildTab)

  if (buildTab === 'builds' || buildTab === 'compare') return <Builds />
  if (buildTab === 'build-dashboard') return <BuildDashboard />
  if (buildTab === 'build-settings') return <BuildSettings />
  if (buildTab === 'lab') return <LabTab />

  return <Builds />
}
