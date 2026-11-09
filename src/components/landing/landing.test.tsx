import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useAppStore } from '@/store/app-store';
import { LandingPage, applyIdea, IdeaChip } from './landing-page';
import { StartInput, canStart } from './start-input';
import { ProjectGrid, filterProjects, formatEdited } from './project-grid';
import type { ProjectSummary } from '@/lib/client/server-projects';
import type { PendingAttachment } from '@/store/app-store';

const origUseSyncExternalStore = React.useSyncExternalStore;

describe('landing page', () => {
  beforeEach(() => {
    React.useSyncExternalStore = (subscribe, getSnapshot) => {
      return origUseSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    };

    // Stub global fetch to prevent network calls from store
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([]))));

    useAppStore.setState({
      projects: [],
      projectsStatus: 'idle',
      pendingAttachment: null,
      selectedModel: 'claude-sonnet-5.5',
    });
  });

  it('the landing renders the heading, the input with an image button and a model selector, two ideas and the project grid', () => {
    const mockProjects: ProjectSummary[] = [
      {
        id: 'proj-1',
        name: 'NEMA Motor Mount',
        updatedAt: Date.now() - 3600000,
        threadCount: 1,
        thumbnailArtifactId: null,
      },
      {
        id: 'proj-2',
        name: 'Pi Enclosure',
        updatedAt: Date.now() - 7200000,
        threadCount: 3,
        thumbnailArtifactId: null,
      },
    ];

    useAppStore.setState({
      projects: mockProjects,
      projectsStatus: 'ready',
    });

    const html = renderToStaticMarkup(<LandingPage rand={() => 0} />);

    // 1. Heading
    expect(html).toContain('What do you want to make?');

    // 2. Textarea
    expect(html).toContain('<textarea');

    // 3. data-slot="image-button" and data-slot="model-select" inside the start box
    // Check they appear between data-slot="start-input" and data-slot="start-button"
    const startBoxIndex = html.indexOf('data-slot="start-input"');
    const imageBtnIndex = html.indexOf('data-slot="image-button"');
    const modelSelectIndex = html.indexOf('data-slot="model-select"');
    const startButtonIndex = html.indexOf('data-slot="start-button"');

    expect(startBoxIndex).toBeGreaterThan(-1);
    expect(imageBtnIndex).toBeGreaterThan(startBoxIndex);
    expect(modelSelectIndex).toBeGreaterThan(startBoxIndex);
    expect(startButtonIndex).toBeGreaterThan(imageBtnIndex);
    expect(startButtonIndex).toBeGreaterThan(modelSelectIndex);

    // 4. Exactly two data-slot="idea-chip"
    const ideaChipMatches = html.match(/data-slot="idea-chip"/g);
    expect(ideaChipMatches).not.toBeNull();
    expect(ideaChipMatches?.length).toBe(2);

    // 5. Both project names and href="/p/<id>"
    expect(html).toContain('NEMA Motor Mount');
    expect(html).toContain('href="/p/proj-1"');
    expect(html).toContain('Pi Enclosure');
    expect(html).toContain('href="/p/proj-2"');

    // 6. "1 thread" and "N threads"
    expect(html).toContain('1 thread');
    expect(html).toContain('3 threads');
  });

  it('clicking an idea fills the input', () => {
    let capturedIdea = '';
    const ideaToSelect = 'Raspberry Pi 5 enclosure with fan and port cutouts';

    // Invoke IdeaChip component function directly to access onClick
    const chipElement = IdeaChip({
      idea: ideaToSelect,
      onSelect: (idea) => {
        capturedIdea = applyIdea(idea);
      },
    });

    // Simulate click
    chipElement.props.onClick();

    expect(capturedIdea).toBe(ideaToSelect);

    // Assert that renderToStaticMarkup with the captured idea renders it in the textarea
    const inputHtml = renderToStaticMarkup(
      <StartInput
        value={capturedIdea}
        onChange={() => {}}
        onStart={() => {}}
      />
    );

    expect(inputHtml).toContain('<textarea');
    expect(inputHtml).toContain(ideaToSelect);
  });

  it('search filters the grid by name', () => {
    const projects: ProjectSummary[] = [
      {
        id: '1',
        name: 'Motor mount',
        updatedAt: 1000,
        threadCount: 1,
        thumbnailArtifactId: null,
      },
      {
        id: '2',
        name: 'Pi enclosure',
        updatedAt: 1000,
        threadCount: 2,
        thumbnailArtifactId: null,
      },
      {
        id: '3',
        name: 'Bracket set',
        updatedAt: 1000,
        threadCount: 4,
        thumbnailArtifactId: null,
      },
    ];

    // filterProjects logic
    const filteredMotor = filterProjects(projects, 'MOTOR');
    expect(filteredMotor.map((p) => p.name)).toEqual(['Motor mount']);

    const filteredEmpty = filterProjects(projects, '');
    expect(filteredEmpty.map((p) => p.name)).toEqual([
      'Motor mount',
      'Pi enclosure',
      'Bracket set',
    ]);

    // Rendered grid with initialSearch="pi"
    const html = renderToStaticMarkup(
      <ProjectGrid projects={projects} status="ready" initialSearch="pi" />
    );

    expect(html).toContain('Pi enclosure');
    expect(html).not.toContain('Motor mount');
  });

  it('Start with empty text is disabled', () => {
    // Predicate checks
    expect(canStart('', null)).toBe(false);
    expect(canStart('   ', null)).toBe(false);
    expect(canStart('bracket', null)).toBe(true);

    const uploadingAttachment: PendingAttachment = {
      localUrl: 'blob:test',
      kind: 'reference',
      status: 'uploading',
    };
    expect(canStart('bracket', uploadingAttachment)).toBe(false);

    const failedAttachment: PendingAttachment = {
      localUrl: 'blob:test',
      kind: 'reference',
      status: 'failed',
    };
    expect(canStart('bracket', failedAttachment)).toBe(false);

    // Rendered markup checks: Start button with value="" has disabled attribute
    const disabledHtml = renderToStaticMarkup(
      <StartInput value="" onChange={() => {}} onStart={() => {}} />
    );
    const disabledBtnMatch = disabledHtml.match(/<button[^>]*data-slot="start-button"[^>]*>/);
    expect(disabledBtnMatch).not.toBeNull();
    expect(disabledBtnMatch![0]).toMatch(/\sdisabled(?:=""|(?=[\s>]))/);

    // Start button with value="bracket" does not have disabled attribute
    const enabledHtml = renderToStaticMarkup(
      <StartInput value="bracket" onChange={() => {}} onStart={() => {}} />
    );
    const enabledBtnMatch = enabledHtml.match(/<button[^>]*data-slot="start-button"[^>]*>/);
    expect(enabledBtnMatch).not.toBeNull();
    expect(enabledBtnMatch![0]).not.toMatch(/\sdisabled(?:=""|(?=[\s>]))/);
  });

  it('formatEdited formats relative edit timestamps correctly', () => {
    const now = 100000000;
    expect(formatEdited(now - 30 * 1000, now)).toBe('edited just now');
    expect(formatEdited(now - 5 * 60 * 1000, now)).toBe('edited 5 min ago');
    expect(formatEdited(now - 2 * 3600 * 1000, now)).toBe('edited 2 h ago');
    expect(formatEdited(now - 26 * 3600 * 1000, now)).toBe('edited yesterday');
    expect(formatEdited(now - 3 * 86400 * 1000, now)).toBe('edited 3 days ago');

    const tenDaysAgo = now - 10 * 86400 * 1000;
    const expectedDate = new Date(tenDaysAgo).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    expect(formatEdited(tenDaysAgo, now)).toBe(`edited ${expectedDate}`);
  });
});
