import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeDrawer, codeDrawerInsets } from './code-drawer';

describe('code drawer', () => {
  it('the code drawer sits between the open panels and widens when they collapse', () => {
    expect(codeDrawerInsets(false, false)).toEqual({ left: 412, right: 372 });
    expect(codeDrawerInsets(true, false)).toEqual({ left: 16, right: 372 });
    expect(codeDrawerInsets(false, true)).toEqual({ left: 412, right: 16 });
    const html = renderToStaticMarkup(<CodeDrawer chatCollapsed={false} inspectorCollapsed={false} />);
    expect(html).toContain('left:412px');
    expect(html).toContain('right:372px');
  });

  it('the code drawer has an opaque surface so code stays readable over the model', () => {
    const html = renderToStaticMarkup(<CodeDrawer chatCollapsed={false} inspectorCollapsed={false} />);
    expect(html).toContain('var(--drawer-bg)');
  });
});
