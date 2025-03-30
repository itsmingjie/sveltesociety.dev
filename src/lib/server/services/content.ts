import { z } from 'zod'
import { Database } from 'bun:sqlite'
import { SearchService } from './search'
import { contentSchema } from '$lib/schema/content'
import type { Content, ContentFilters } from '$lib/types/content'
import type { Tag } from '$lib/types/tags'

export class ContentService {
	private searchService: SearchService

	constructor(private db: Database) {
		this.searchService = new SearchService(db)
	}

	getContentById(id: string): Content | null {
		if (!id) {
			console.error('Invalid content ID:', id);
			return null;
		}

		try {
			// Begin transaction
			this.db.exec('BEGIN TRANSACTION');

			// Get the main content
			const contentQuery = this.db.prepare(`
				SELECT * FROM content
				WHERE id = ?
			`);
			const content = contentQuery.get(id) as Content | null;

			if (!content) {
				this.db.exec('ROLLBACK');
				return null;
			}

			// Get tags for the main content
			const tagsQuery = this.db.prepare(`
				SELECT t.id, t.name, t.slug, t.created_at, t.updated_at
				FROM tags t
				JOIN content_to_tags ctt ON t.id = ctt.tag_id
				WHERE ctt.content_id = ?
			`);
			const tags = tagsQuery.all(id) as Tag[];
			content.tags = tags || [];
			
			// If it's a collection and has children stored as JSON
			if (content.type === 'collection' && typeof content.children === 'string') {
				try {
					// Parse the JSON to get child IDs
					const childrenIds = JSON.parse(content.children);
					
					if (Array.isArray(childrenIds) && childrenIds.length > 0) {
						// Process each child individually instead of using IN clause
						const childrenContent: Content[] = [];
						
						// Prepare statements for reuse
						const childContentQuery = this.db.prepare(`
							SELECT c.* 
							FROM content c
							WHERE c.id = ?
						`);
						
						const childTagsQuery = this.db.prepare(`
							SELECT t.id, t.name, t.slug, t.created_at, t.updated_at
							FROM tags t
							JOIN content_to_tags ctt ON t.id = ctt.tag_id
							WHERE ctt.content_id = ?
						`);
						
						// Process each child ID individually
						for (const childId of childrenIds) {
							// Get the child content
							const childContent = childContentQuery.get(childId) as Content | null;
							
							if (childContent) {
								// Get tags for this child
								const childTags = childTagsQuery.all(childId) as Tag[];
								
								// Assign tags and empty children array
								childContent.tags = childTags || [];
								childContent.children = [];
								
								// Add to the children collection
								childrenContent.push(childContent);
							}
						}
						
						// Set the children on the parent content
						content.children = childrenContent
					}
				} catch (e) {
					console.error('Error processing collection children:', e);
					content.children = [];
				}
			}
			
			// Commit transaction
			this.db.exec('COMMIT');
			return content;
		} catch (e) {
			// Rollback transaction on error
			try {
				this.db.exec('ROLLBACK');
			} catch (rollbackError) {
				console.error('Error during transaction rollback:', rollbackError);
			}
			
			console.error(`Error fetching content with ID ${id}:`, e);
			return null;
		}
	}

	getFilteredContent(filters: ContentFilters = {}) : Content[] {
		let contentIds: string[] = []

		if (filters.search?.trim()) {
			contentIds = this.searchService.search({ query: filters.search.trim() })
		}

		let query = `
			SELECT DISTINCT c.id
			FROM content c
		`

		const params: any[] = []
		const whereConditions: string[] = []
		const havingConditions: string[] = []

		if (filters.search?.trim()) {
			if (contentIds.length === 0) {
				return []
			}
			whereConditions.push(`c.id IN (${contentIds.map(() => '?').join(',')})`)
			params.push(...contentIds)
		}

		if (filters.status !== 'all') {
			whereConditions.push(filters.status ? 'c.status = ?' : "c.status = 'published'")
			if (filters.status) params.push(filters.status)
		}

		if (filters.type) {
			whereConditions.push('c.type = ?')
			params.push(filters.type)
		}

		if (filters.tags) {
			const tags = Array.isArray(filters.tags) ? filters.tags : [filters.tags]
			if (tags.length > 0) {
				query += `
          JOIN content_to_tags ctt ON c.id = ctt.content_id
          JOIN tags t ON ctt.tag_id = t.id
        `
				whereConditions.push(`t.slug IN (${tags.map(() => '?').join(',')})`)
				params.push(...tags)

				if (tags.length > 1) {
					havingConditions.push('COUNT(DISTINCT t.slug) = ?')
					params.push(tags.length)
				}
			}
		}

		if (whereConditions.length > 0) {
			query += ' WHERE ' + whereConditions.join(' AND ')
		}

		if (filters.tags && Array.isArray(filters.tags) && filters.tags.length > 1) {
			query += ' GROUP BY c.id'
			if (havingConditions.length > 0) {
				query += ' HAVING ' + havingConditions.join(' AND ')
			}
		}

		query += ' ORDER BY '
		if (filters.sort === 'latest') {
			query += 'c.published_at DESC, c.created_at DESC'
		} else if (filters.sort === 'oldest') {
			query += 'c.published_at ASC, c.created_at ASC'
		} else if (filters.sort === 'popular') {
			query += 'c.likes DESC, c.saves DESC'
		} else {
			query += 'c.published_at DESC, c.created_at DESC'
		}

		if (filters.limit) {
			query += ' LIMIT ?'
			params.push(filters.limit)
			if (filters.offset) {
				query += ' OFFSET ?'
				params.push(filters.offset)
			}
		}

		const ids = this.db.prepare(query).all(...params) as { id: string }[]

		return ids
			.map(({ id }) => this.getContentById(id))
			.filter((content): content is Content => content !== null)
	}

	getFilteredContentCount(filters: Omit<ContentFilters, 'limit' | 'offset' | 'sort'> = {}) {
		let contentIds: string[] = []


		if (filters.search?.trim()) {
			contentIds = this.searchService.search({ query: filters.search.trim() })
			if (contentIds.length === 0) return 0
		}

		let query = 'SELECT COUNT(DISTINCT c.id) as total FROM content c'
		const params: any[] = []
		const whereConditions: string[] = []
		const havingConditions: string[] = []


		if (filters.search?.trim()) {
			whereConditions.push(`c.id IN (${contentIds.map(() => '?').join(',')})`)
			params.push(...contentIds)
		}


		if (filters.status === 'all') {
			// Don't add any status condition when requesting all content
		} else {
			whereConditions.push(filters.status ? 'c.status = ?' : "c.status = 'published'")
			if (filters.status) params.push(filters.status)
		}


		if (filters.type) {
			whereConditions.push('c.type = ?')
			params.push(filters.type)
		}


		if (filters.tags) {
			const tags = Array.isArray(filters.tags) ? filters.tags : [filters.tags]
			if (tags.length > 0) {
				query += `
          JOIN content_to_tags ctt ON c.id = ctt.content_id
          JOIN tags t ON ctt.tag_id = t.id
        `
				whereConditions.push(`t.slug IN (${tags.map(() => '?').join(',')})`)
				params.push(...tags)

				if (tags.length > 1) {
					havingConditions.push('COUNT(DISTINCT t.slug) = ?')
					params.push(tags.length)
				}
			}
		}


		if (whereConditions.length > 0) {
			query += ' WHERE ' + whereConditions.join(' AND ')
		}


		if (filters.tags && Array.isArray(filters.tags) && filters.tags.length > 1) {
			query += ' GROUP BY c.id'
			if (havingConditions.length > 0) {
				query += ' HAVING ' + havingConditions.join(' AND ')
			}

			query = `SELECT COUNT(*) as total FROM (${query})`
		}

		const result = this.db.prepare(query).get(...params) as { total: number }
		return result?.total || 0
	}

	searchBlogPosts(searchTerm: string, tags: string[] = []) {
		return this.getFilteredContent({
			type: 'blog',
			search: searchTerm,
			tags: tags.length > 0 ? tags : undefined,
			sort: 'latest'
		})
	}

	getContentByTag(tagSlug: string, limit = 10, offset = 0) {
		const results = this.getFilteredContent({
			tags: tagSlug,
			limit,
			offset
		});
		
		// Ensure every item has a children array
		return results.map(item => ({
			...item,
			children: item.children || []
		}));
	}

	getContentByType(type: string, limit = 10, offset = 0) {
		const results = this.getFilteredContent({
			type,
			limit,
			offset
		});
		
		// Ensure every item has a children array
		return results.map(item => ({
			...item,
			children: item.children || []
		}));
	}

	addContent(data: {
		title: string
		slug: string
		description: string
		type: string
		status: string
		body: string
		tags: string[]
		metadata?: {
			videoId?: string
			npm?: string
		}
	}) {
		const id = crypto.randomUUID()
		const now = new Date().toISOString()

		this.db
			.prepare(
				`
			INSERT INTO content (
				id, title, slug, description, type, status, 
				body, created_at, updated_at, published_at,
				likes, saves
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
		`
			)
			.run(
				id,
				data.title,
				data.slug,
				data.description,
				data.type,
				data.status,
				data.body,
				now,
				now,
				data.status === 'published' ? now : null
			)

		// Add tags if present
		if (data.tags && data.tags.length > 0) {
			const insertTagStmt = this.db.prepare(
				`INSERT INTO content_to_tags (content_id, tag_id) VALUES (?, ?)`
			)

			for (const tag of data.tags) {
				insertTagStmt.run(id, tag)
			}
		}

		return id
	}

	updateContent(id: string, data: {
		title: string
		slug: string
		description: string
		type: string
		status: string
		body: string
		tags: string[]
		metadata?: {
			videoId?: string
			npm?: string
		}
	}) {
		const now = new Date().toISOString()

		// Update the content record
		this.db
			.prepare(
				`
				UPDATE content 
				SET title = ?,
					slug = ?,
					description = ?,
					type = ?,
					status = ?,
					body = ?,
					updated_at = ?,
					published_at = CASE 
						WHEN status != 'published' AND ? = 'published' THEN ?
						WHEN status = 'published' AND ? != 'published' THEN NULL
						ELSE published_at
					END
				WHERE id = ?
				`
			)
			.run(
				data.title,
				data.slug,
				data.description,
				data.type,
				data.status,
				data.body,
				now,
				data.status,
				now,
				data.status,
				id
			)

		// Delete existing tag associations
		this.db.prepare('DELETE FROM content_to_tags WHERE content_id = ?').run(id)

		// Add new tag associations if present
		if (data.tags && data.tags.length > 0) {
			const insertTagStmt = this.db.prepare(
				`INSERT INTO content_to_tags (content_id, tag_id) VALUES (?, ?)`
			)

			for (const tag of data.tags) {
				insertTagStmt.run(id, tag)
			}
		}
	}

	getContentBySlug(slug: string, type?: string): Content | null {
		if (!slug) {
			console.error('Invalid slug:', slug);
			return null;
		}

		try {
			// Build the query based on whether type is provided
			let query = `
				SELECT * FROM content
				WHERE slug = ? AND status = 'published'
			`;
			
			const params: any[] = [slug];
			
			if (type) {
				query = `
					SELECT * FROM content
					WHERE slug = ? AND type = ? AND status = 'published'
				`;
				params.push(type);
			}
			
			// Get the basic content item
			const contentQuery = this.db.prepare(query);
			const content = contentQuery.get(...params) as Content | null;

			if (!content) {
				return null;
			}

			// Return the content with children populated
			return this.getContentById(content.id);
		} catch (e) {
			console.error(`Error fetching content with slug ${slug}:`, e);
			return null;
		}
	}
}