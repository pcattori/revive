import MdxComponent, { attributes, filename } from './file.mdx'

export default () => (
  <>
    <MdxComponent />
    <p>filename export: {JSON.stringify(filename)}</p>
    <p>attributes export: {JSON.stringify(attributes)}</p>
  </>
)
