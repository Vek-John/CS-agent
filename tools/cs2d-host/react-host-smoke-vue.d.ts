// Standard Vue SFC module boundary; production SFC internals are checked by the Viewer vue-tsc build.
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent;
  export default component;
}
