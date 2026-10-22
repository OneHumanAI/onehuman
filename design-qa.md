# Portal sidebar design QA

- Source visual truth: `/var/folders/dp/7250vg8x101glzyh4wrrxkkh0000gn/T/TemporaryItems/NSIRD_screencaptureui_yvRYX9/Screenshot 2026-10-18 at 17.56.22.png`
- Source pixels: 396 × 1722.
- Implementation: `https://app.onehuman.ai/#overview`.
- Implementation screenshot: in-app browser production capture from this task, 988 × 887 pixels.
- CSS viewport and density: desktop browser viewport, device scale factor 1. The source is a narrow sidebar crop, so the comparison was normalized to the sidebar component rather than the full page.
- State: signed-in workspace, Overview selected, dark theme, all sidebar groups expanded.

## Full-view comparison evidence

The source showed the legacy flat navigation stacked above the newer workspace navigation. The production capture after the fix shows one sidebar only: workspace switcher, Overview, the Monitor/Protect/Developers groups, account links, and the agent-session card. The main content starts immediately beside that single sidebar with no horizontal overflow.

## Focused region comparison evidence

The sidebar was inspected directly because it is the complete visual target. Production DOM verification found exactly one visible Overview navigation link, the legacy navigation has `hidden`, and the three requested group labels are Monitor, Protect, and Developers.

## Required fidelity surfaces

- Fonts and typography: existing Inter/Geist stack, weights, sizes, and muted hierarchy remain unchanged; the grouped sidebar labels now use the intended smaller section hierarchy.
- Spacing and layout rhythm: the duplicate vertical block is gone; workspace, groups, account links, and footer card form one continuous column with no overflow.
- Colors and visual tokens: existing OneHuman dark tokens and mint active state are preserved.
- Image quality and asset fidelity: no raster imagery is used in this component; the existing project icon assets remain unchanged and sharp.
- Copy and content: the retained lower navigation uses Overview, Monitor, AI agents, Activity, Reports, Protect, Rules, Developers, API keys, Set up, Plan & usage, Settings, and Docs as shown in the selected target.

## Findings

No actionable P0, P1, or P2 differences remain for the requested duplicate-sidebar correction.

## Comparison history

1. Initial source evidence: two complete navigation systems were visible in one sidebar (P1).
2. Fix: hid the legacy flat navigation and status row, promoted the workspace switcher, and styled the grouped navigation and footer card as the single sidebar.
3. Post-fix production evidence: one visible navigation, no horizontal overflow, and no browser console errors.

## Primary interactions tested

- Production Overview route loaded while signed in.
- Collapsible group controls rendered in their expanded state.
- Active Overview item rendered once.
- Browser console error log was empty.

## Follow-up polish

None required for this scoped fix.

final result: passed
