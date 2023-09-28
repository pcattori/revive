import MdxComponent, { frontmatter } from './file.mdx'

export default () => (
  <>
    <MdxComponent />
    <p>frontmatter: {JSON.stringify(frontmatter)}</p>
  </>
)
