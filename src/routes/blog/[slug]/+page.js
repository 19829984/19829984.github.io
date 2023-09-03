import { error } from '@sveltejs/kit';

/** @type {import('./$types').PageLoad} */
export async function load({ params }) {
    try {
        const post = await import(`../${params.slug}.md`)
        const { title, date } = post.metadata
        const content = post.default;

        return {
            content,
            title,
            date
        }
    } catch (error) {
        console.log(error)
        throw error(404, 'Not found');
    }
}

