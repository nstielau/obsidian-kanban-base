/* Test doubles implement only the folder fields used by the view. */
/* eslint-disable obsidianmd/no-tfile-tfolder-cast */
import { act, cleanup, fireEvent, waitFor } from '@testing-library/preact'
import type { TFile, TFolder } from 'obsidian'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aBasesEntry } from '../../__mocks__/aBasesEntry'
import { aFile } from '../../__mocks__/aFile'
import { createMockApp } from '../../__mocks__/create-mock-app'
import { KanbanFolderView } from './KanbanFolderView'

const views: KanbanFolderView[] = []
afterEach(() => {
	views.splice(0).forEach(view => view.onunload())
	cleanup()
})

function setup(storage: Record<string, unknown> = {}) {
	const root = {
		name: 'Board',
		path: 'Board',
		children: [],
	} as unknown as TFolder
	const folders = ['Next', 'Doing', 'Done'].map(
		name =>
			({
				name,
				path: `Board/${name}`,
				parent: root,
				children: [],
				isRoot: () => false,
			}) as unknown as TFolder,
	)
	root.children = folders
	const files = ['a', 'b', 'c'].map(basename =>
		aFile({
			basename,
			path: `Board/Next/${basename}.md`,
			parent: folders[0],
		}),
	)
	files.push(
		aFile({ basename: 'd', path: 'Board/Doing/d.md', parent: folders[1] }),
	)
	const entries = files.map(file => aBasesEntry({ file }))
	const renameFile = vi.fn(async (file: TFile, path: string) => {
		file.path = path
		file.parent = folders.find(folder =>
			path.startsWith(folder.path + '/'),
		)!
	})
	const app = createMockApp({
		vault: {
			getFolderByPath: () => root,
			getAbstractFileByPath: (path: string) =>
				files.find(file => file.path === path),
		} as never,
		fileManager: { renameFile } as never,
	})
	storage.columnRoot = 'Board'
	const config = {
		get: (key: string) => storage[key] ?? null,
		set: (key: string, value: unknown) => {
			storage[key] = value
		},
		getOrder: () => [],
	}
	const container = document.createElement('div')
	document.body.append(container)
	const view = new KanbanFolderView(
		{ app, config, data: { data: entries } } as never,
		container,
	)
	views.push(view)
	void act(() => view.onDataUpdated())
	const titles = (column: string) => {
		const el = Array.from(
			container.querySelectorAll('.kanban-base-column'),
		).find(el => el.querySelector('h2')?.textContent === column)!
		return Array.from(el.querySelectorAll('.kanban-base-card-title')).map(
			el => el.textContent,
		)
	}
	return { view, storage, renameFile, container, titles }
}

describe('folder card reordering', () => {
	it('persists same-column order across refresh and a newly opened view without moving files', async () => {
		const ctx = setup()
		await act(() =>
			ctx.view.dropCard('Board/Next/c.md', 'Next', {
				path: 'Board/Next/a.md',
				side: 'before',
			}),
		)
		expect(ctx.titles('Next')).toEqual(['c', 'a', 'b'])
		expect(ctx.renameFile).not.toHaveBeenCalled()
		await act(() => ctx.view.onDataUpdated())
		expect(ctx.titles('Next')).toEqual(['c', 'a', 'b'])
		const reopened = setup(
			JSON.parse(JSON.stringify(ctx.storage)) as Record<string, unknown>,
		)
		expect(reopened.titles('Next')).toEqual(['c', 'a', 'b'])
	})
	it('places cross-column drops precisely and uses the link-aware file manager', async () => {
		const ctx = setup()
		await act(() =>
			ctx.view.dropCard('Board/Next/b.md', 'Doing', {
				path: 'Board/Doing/d.md',
				side: 'before',
			}),
		)
		expect(ctx.renameFile).toHaveBeenCalledOnce()
		expect(ctx.titles('Doing')).toEqual(['b', 'd'])
		expect(ctx.titles('Next')).toEqual(['a', 'c'])
		expect(ctx.storage.cardOrder).not.toContain('Board/Next/b.md')
	})
	it('supports empty columns and retains filtered-out positions', async () => {
		const ctx = setup({
			cardOrder: JSON.stringify([
				'Board/Next/hidden.md',
				'Board/Next/b.md',
			]),
		})
		await act(() => ctx.view.dropCard('Board/Next/a.md', 'Done'))
		expect(ctx.titles('Done')).toEqual(['a'])
		expect(ctx.storage.cardOrder).toContain('Board/Next/hidden.md')
	})
	it('does not save a new order when the file move fails', async () => {
		const ctx = setup()
		ctx.renameFile.mockRejectedValueOnce(
			new Error('Destination already exists'),
		)
		await expect(
			ctx.view.dropCard('Board/Next/a.md', 'Doing'),
		).rejects.toThrow('Destination already exists')
		expect(ctx.storage.cardOrder).toBeUndefined()
		expect(ctx.titles('Next')).toEqual(['a', 'b', 'c'])
	})
	it('ignores self-drops and invalid insertion targets', async () => {
		const ctx = setup()
		await ctx.view.dropCard('Board/Next/a.md', 'Next', {
			path: 'Board/Next/a.md',
			side: 'before',
		})
		await ctx.view.dropCard('Board/Next/a.md', 'Doing', {
			path: 'Board/Next/b.md',
			side: 'before',
		})
		expect(ctx.storage.cardOrder).toBeUndefined()
		expect(ctx.renameFile).not.toHaveBeenCalled()
	})
	it('drags a card down within a column, shows an insertion marker, and clears it on drop', async () => {
		const ctx = setup()
		const cards = Array.from(
			ctx.container.querySelectorAll<HTMLElement>('.kanban-base-card'),
		)
		const a = cards.find(el => el.dataset.filePath === 'Board/Next/a.md')!
		const column = a.closest<HTMLElement>('.kanban-base-column')!
		const columnCards = Array.from(
			column.querySelectorAll<HTMLElement>('.kanban-base-card'),
		)
		columnCards.forEach((el, index) => {
			vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
				top: index * 100,
				height: 80,
			} as DOMRect)
		})
		const dataTransfer = {
			types: ['text/card'],
			setData: vi.fn(),
			effectAllowed: '',
			dropEffect: 'move',
		}
		fireEvent.dragStart(a, { dataTransfer })
		// jsdom has no native DragEvent; provide coordinates explicitly.
		const dragEvent = (type: string, clientY: number) => {
			const event = new Event(type, { bubbles: true, cancelable: true })
			Object.assign(event, { dataTransfer, clientY })
			fireEvent(column, event)
		}
		dragEvent('dragover', 290)
		await waitFor(() =>
			expect(
				column.querySelector('.kanban-base-card--insert-after'),
			).not.toBeNull(),
		)
		dragEvent('drop', 290)
		await waitFor(() => expect(ctx.titles('Next')).toEqual(['b', 'c', 'a']))
		expect(
			column.querySelector('.kanban-base-card--insert-after'),
		).toBeNull()
		expect(ctx.renameFile).not.toHaveBeenCalled()
	})
})
