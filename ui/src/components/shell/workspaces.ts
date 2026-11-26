// Workspace presets for the docking layout (flexlayout-react JSON models).
import type { IJsonModel, IJsonRowNode, IJsonTabSetNode } from 'flexlayout-react';

export type PanelId = 'media' | 'library' | 'viewer' | 'inspector' | 'timeline' | 'graph' | 'scopes' | 'mixer' | 'queue' | 'hierarchy';

export const PANEL_NAMES: Record<PanelId, string> = {
  media: 'Media', library: 'Library', viewer: 'Viewer', inspector: 'Inspector', timeline: 'Timeline', graph: 'Graph Editor',
  scopes: 'Scopes', mixer: 'Audio Mixer', queue: 'Render Queue', hierarchy: 'Hierarchy',
};

const tab = (id: PanelId) => ({ type: 'tab' as const, name: PANEL_NAMES[id], component: id, id: `tab-${id}` });
const set = (weight: number, ids: PanelId[], selected = 0): IJsonTabSetNode => ({ type: 'tabset', weight, selected, children: ids.map(tab) });
const row = (weight: number, children: (IJsonRowNode | IJsonTabSetNode)[]): IJsonRowNode => ({ type: 'row', weight, children });

const GLOBAL: IJsonModel['global'] = {
  tabEnableClose: true,
  tabEnableRename: false,
  tabSetMinWidth: 160,
  tabSetMinHeight: 90,
  tabSetEnableMaximize: true,
  tabEnablePopout: false,
  splitterSize: 4,
};

function model(layout: IJsonRowNode): IJsonModel {
  return { global: GLOBAL, borders: [], layout };
}

// A row's children alternate orientation: row (horizontal) -> row (vertical) -> ...
export const WORKSPACES: Record<string, () => IJsonModel> = {
  Editing: () => model(row(100, [
    row(62, [set(22, ['media', 'library']), set(53, ['viewer']), set(25, ['inspector', 'hierarchy'])]),
    set(38, ['timeline', 'graph', 'mixer']),
  ])),
  'Motion Graphics': () => model(row(100, [
    row(56, [set(18, ['library', 'media']), set(54, ['viewer']), set(28, ['inspector'])]),
    row(44, [set(58, ['timeline']), set(42, ['graph'])]),
  ])),
  Compositing: () => model(row(100, [
    row(60, [set(18, ['media', 'library']), set(57, ['viewer']), set(25, ['inspector', 'hierarchy'])]),
    row(40, [set(75, ['timeline', 'graph']), set(25, ['hierarchy'])]),
  ])),
  'Colour Grading': () => model(row(100, [
    row(62, [set(60, ['viewer']), set(40, ['inspector'])]),
    row(38, [set(45, ['scopes']), set(55, ['timeline'])]),
  ])),
  '3D Workspace': () => model(row(100, [
    row(64, [set(18, ['library', 'media']), set(54, ['viewer']), set(28, ['inspector', 'hierarchy'])]),
    set(36, ['timeline', 'graph']),
  ])),
  Audio: () => model(row(100, [
    row(50, [set(25, ['media']), set(45, ['viewer']), set(30, ['inspector'])]),
    row(50, [set(68, ['timeline']), set(32, ['mixer'])]),
  ])),
  Effects: () => model(row(100, [
    row(62, [set(22, ['library']), set(50, ['viewer']), set(28, ['inspector'])]),
    set(38, ['timeline', 'graph']),
  ])),
  Minimal: () => model(row(100, [
    set(64, ['viewer']),
    set(36, ['timeline']),
  ])),
};

export const WORKSPACE_NAMES = Object.keys(WORKSPACES);
