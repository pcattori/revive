/// <reference types="@remix-run/node" />

declare module '*.mdx' {
  let MDXComponent: (props) => JSX.Element
  export const frontmatter: any
  export default MDXComponent
}
