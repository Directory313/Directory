import { describe, expect, it } from 'vitest';
import { Model } from 'flexlayout-react';
import { WORKSPACES, WORKSPACE_NAMES } from './workspaces';

describe('workspace presets', () => {
  it.each(WORKSPACE_NAMES)('%s loads (no duplicate panels)', (name) => {
    expect(() => Model.fromJson(WORKSPACES[name]())).not.toThrow();
  });
});
