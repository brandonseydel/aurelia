import { DI, IContainer, Key, Reporter } from '@aurelia/kernel';
import { Aurelia, ICustomElementType, IRenderContext } from '@aurelia/runtime';
import { BrowserNavigation, INavigationViewerEvent } from './browser-navigation';
import { InstructionResolver, IRouteSeparators } from './instruction-resolver';
import { AnchorEventInfo, LinkHandler } from './link-handler';
import { INavRoute, Nav } from './nav';
import { INavigationEntry, INavigationInstruction, INavigatorOptions, Navigator } from './navigator';
import { IParsedQuery, parseQuery } from './parser';
import { QueueItem } from './queue';
import { RouteTable } from './route-table';
import { Scope } from './scope';
import { arrayRemove } from './utils';
import { IViewportOptions, Viewport } from './viewport';
import { ViewportInstruction } from './viewport-instruction';

export interface IRouteTransformer {
  transformFromUrl?(route: string, router: Router): string | ViewportInstruction[];
  transformToUrl?(instructions: ViewportInstruction[], router: Router): string | ViewportInstruction[];
}

export const IRouteTransformer = DI.createInterface<IRouteTransformer>('IRouteTransformer').withDefault(x => x.singleton(RouteTable));

export interface IRouterOptions extends INavigatorOptions, IRouteTransformer {
  separators?: IRouteSeparators;
  reportCallback?(instruction: INavigationInstruction): void;
}

export interface IRouteViewport {
  name: string;
  component: Partial<ICustomElementType> | string;
}

export interface IRouter {
  readonly isNavigating: boolean;

  activate(options?: IRouterOptions): Promise<void>;
  deactivate(): void;

  linkCallback(info: AnchorEventInfo): void;

  processNavigations(qInstruction: QueueItem<INavigationInstruction>): Promise<void>;
  addProcessingViewport(componentOrInstruction: string | Partial<ICustomElementType> | ViewportInstruction, viewport?: Viewport | string): void;

  // Called from the viewport custom element in attached()
  addViewport(name: string, element: Element, context: IRenderContext, options?: IViewportOptions): Viewport;
  // Called from the viewport custom element
  removeViewport(viewport: Viewport, element: Element, context: IRenderContext): void;

  allViewports(): Viewport[];
  findScope(element: Element): Scope;
  removeScope(scope: Scope): void;

  goto(pathOrViewports: string | Record<string, Viewport>, title?: string, data?: Record<string, unknown>): Promise<void>;
  replace(pathOrViewports: string | Record<string, Viewport>, title?: string, data?: Record<string, unknown>): Promise<void>;
  refresh(): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;

  setNav(name: string, routes: INavRoute[]): void;
  addNav(name: string, routes: INavRoute[]): void;
  findNav(name: string): Nav;
}

export const IRouter = DI.createInterface<IRouter>('IRouter').withDefault(x => x.singleton(Router));

export class Router implements IRouter {
  public static readonly inject: readonly Key[] = [IContainer, Navigator, BrowserNavigation, IRouteTransformer, LinkHandler, InstructionResolver];

  public readonly container: IContainer;

  public rootScope: Scope;
  public scopes: Scope[] = [];

  public navigator: Navigator;
  public navigation: BrowserNavigation;

  public linkHandler: LinkHandler;
  public instructionResolver: InstructionResolver;

  public navs: Record<string, Nav> = {};
  public activeComponents: string[] = [];

  public addedViewports: ViewportInstruction[] = [];

  private options: IRouterOptions;
  private isActive: boolean = false;

  private readonly routeTransformer: IRouteTransformer;
  private processingNavigation: INavigationInstruction = null;
  private lastNavigation: INavigationInstruction = null;

  constructor(
    container: IContainer,
    navigator: Navigator,
    navigation: BrowserNavigation,
    routeTransformer: IRouteTransformer,
    linkHandler: LinkHandler,
    instructionResolver: InstructionResolver
  ) {
    this.container = container;
    this.navigator = navigator;
    this.navigation = navigation;
    this.routeTransformer = routeTransformer;
    this.linkHandler = linkHandler;
    this.instructionResolver = instructionResolver;
  }

  public get isNavigating(): boolean {
    return this.processingNavigation !== null;
  }

  public activate(options?: IRouterOptions): Promise<void> {
    if (this.isActive) {
      throw new Error('Router has already been activated');
    }

    this.isActive = true;
    this.options = {
      ...{
        transformFromUrl: this.routeTransformer.transformFromUrl,
        transformToUrl: this.routeTransformer.transformToUrl,
      }, ...options
    };

    this.instructionResolver.activate({ separators: this.options.separators });
    this.navigator.activate({
      callback: this.navigatorCallback,
      store: this.navigation,
    });
    this.linkHandler.activate({ callback: this.linkCallback });
    return this.navigation.activate(this.navigationCallback);
  }

  public deactivate(): void {
    if (!this.isActive) {
      throw new Error('Router has not been activated');
    }
    this.linkHandler.deactivate();
    this.navigator.deactivate();
    this.navigation.deactivate();
  }

  public linkCallback = (info: AnchorEventInfo): void => {
    let href = info.href;
    if (href.startsWith('#')) {
      href = href.substring(1);
    }
    if (!href.startsWith('/')) {
      const scope = this.closestScope(info.anchor);
      const context = scope.scopeContext();
      href = this.instructionResolver.buildScopedLink(context, href);
    }
    // Adds to Navigator's Queue, which makes sure it's serial
    this.goto(href).catch(error => { throw error; });
  }

  public navigatorCallback = (instruction: INavigationInstruction): void => {
    // Instructions extracted from queue, one at a time
    this.processNavigations(instruction).catch(error => { throw error; });
  }
  public navigationCallback = (navigation: INavigationViewerEvent): void => {
    const entry = (navigation.state && navigation.state.NavigationEntry ? navigation.state.NavigationEntry as INavigationEntry : { instruction: null, fullStateInstruction: null });
    entry.instruction = navigation.instruction;
    entry.fromBrowser = true;
    this.navigator.navigate(entry).catch(error => { throw error; });
  }

  public processNavigations = async (qInstruction: QueueItem<INavigationInstruction>): Promise<void> => {
    const instruction = this.processingNavigation = qInstruction as INavigationInstruction;

    if (this.options.reportCallback) {
      this.options.reportCallback(instruction);
    }

    let fullStateInstruction: boolean = false;
    if ((instruction.navigation.back || instruction.navigation.forward) && instruction.fullStateInstruction) {
      fullStateInstruction = true;
      // tslint:disable-next-line:no-commented-code
      // if (!confirm('Perform history navigation?')) {
      //   this.navigator.cancel(instruction);
      //   this.processingNavigation = null;
      //   return Promise.resolve();
      // }
    }

    let views: ViewportInstruction[];
    let clearViewports: boolean;
    if (typeof instruction.instruction === 'string') {
      let path = instruction.instruction;
      if (this.options.transformFromUrl && !fullStateInstruction) {
        const routeOrInstructions = this.options.transformFromUrl(path, this);
        // TODO: Don't go via string here, use instructions as they are
        path = Array.isArray(routeOrInstructions) ? this.instructionResolver.stringifyViewportInstructions(routeOrInstructions) : routeOrInstructions;
      }

      // TODO: Clean up clear viewports
      const { clear, newPath } = this.instructionResolver.shouldClearViewports(path);
      clearViewports = clear;
      if (clearViewports) {
        path = newPath;
      }
      views = this.instructionResolver.parseViewportInstructions(path);
      // TODO: Used to have an early exit if no views. Restore it?
    } else {
      views = instruction.instruction;
      // TODO: Used to have an early exit if no views. Restore it?
    }

    const parsedQuery: IParsedQuery = parseQuery(instruction.query);
    instruction.parameters = parsedQuery.parameters;
    instruction.parameterList = parsedQuery.list;

    // TODO: Fetch title (probably when done)

    const usedViewports = (clearViewports ? this.allViewports().filter((value) => value.content.component !== null) : []);
    const doneDefaultViewports: Viewport[] = [];
    let defaultViewports = this.allViewports().filter(viewport =>
      viewport.options.default
      && viewport.content.component === null
      && doneDefaultViewports.every(done => done !== viewport)
    );
    const updatedViewports: Viewport[] = [];

    // TODO: Take care of cancellations down in subsets/iterations
    let { viewportInstructions, viewportsRemaining } = this.rootScope.findViewports(views);
    let guard = 100;
    while (viewportInstructions.length || viewportsRemaining || defaultViewports.length || clearViewports) {
      // Guard against endless loop
      if (!guard--) {
        throw Reporter.error(2002);
      }

      for (const defaultViewport of defaultViewports) {
        doneDefaultViewports.push(defaultViewport);
        if (viewportInstructions.every(value => value.viewport !== defaultViewport)) {
          const defaultInstruction = this.instructionResolver.parseViewportInstruction(defaultViewport.options.default);
          defaultInstruction.viewport = defaultViewport;
          viewportInstructions.push(defaultInstruction);
        }
      }

      const changedViewports: Viewport[] = [];
      for (const viewportInstruction of viewportInstructions) {
        const viewport = viewportInstruction.viewport;
        const componentWithParameters = this.instructionResolver.stringifyViewportInstruction(viewportInstruction, true);
        if (viewport.setNextContent(componentWithParameters, instruction)) {
          changedViewports.push(viewport);
        }
        arrayRemove(usedViewports, value => value === viewport);
      }
      // usedViewports is empty if we're not clearing viewports
      for (const viewport of usedViewports) {
        if (viewport.setNextContent(this.instructionResolver.clearViewportInstruction, instruction)) {
          changedViewports.push(viewport);
        }
      }

      let results = await Promise.all(changedViewports.map((value) => value.canLeave()));
      if (results.some(result => result === false)) {
        return this.cancelNavigation([...changedViewports, ...updatedViewports], instruction);
      }
      results = await Promise.all(changedViewports.map(async (value) => {
        const canEnter = await value.canEnter();
        if (typeof canEnter === 'boolean') {
          if (canEnter) {
            return value.enter();
          } else {
            return false;
          }
        }
        for (const viewportInstruction of canEnter) {
          // TODO: Abort content change in the viewports
          this.addProcessingViewport(viewportInstruction);
        }
        value.abortContentChange().catch(error => { throw error; });
        return true;
      }));
      if (results.some(result => result === false)) {
        return this.cancelNavigation([...changedViewports, ...updatedViewports], qInstruction);
      }

      for (const viewport of changedViewports) {
        if (updatedViewports.every(value => value !== viewport)) {
          updatedViewports.push(viewport);
        }
      }

      // TODO: Fix multi level recursiveness!
      const remaining = this.rootScope.findViewports();
      viewportInstructions = [];
      let addedViewport: ViewportInstruction;
      while (addedViewport = this.addedViewports.shift()) {
        // TODO: Should this overwrite instead? I think so.
        if (remaining.viewportInstructions.every(value => value.viewport !== addedViewport.viewport)) {
          viewportInstructions.push(addedViewport);
        }
      }
      viewportInstructions = [...viewportInstructions, ...remaining.viewportInstructions];
      viewportsRemaining = remaining.viewportsRemaining;
      defaultViewports = this.allViewports().filter(viewport =>
        viewport.options.default
        && viewport.content.component === null
        && doneDefaultViewports.every(done => done !== viewport)
      );
      if (!this.allViewports().length) {
        viewportsRemaining = false;
      }
      clearViewports = false;
    }

    await Promise.all(updatedViewports.map((value) => value.loadContent()));
    await this.replacePaths(instruction);

    // Remove history entry if no history viewports updated
    if (instruction.navigation.new && !instruction.navigation.first && !instruction.repeating && updatedViewports.every(viewport => viewport.options.noHistory)) {
      instruction.untracked = true;
    }

    updatedViewports.forEach((viewport) => {
      viewport.finalizeContentChange();
    });
    this.lastNavigation = this.processingNavigation;
    if (this.lastNavigation.repeating) {
      this.lastNavigation.repeating = false;
    }
    this.processingNavigation = null;
    await this.navigator.finalize(instruction);
  }

  public addProcessingViewport(componentOrInstruction: string | Partial<ICustomElementType> | ViewportInstruction, viewport?: Viewport | string): void {
    if (this.processingNavigation) {
      if (componentOrInstruction instanceof ViewportInstruction) {
        if (!componentOrInstruction.viewport) {
          // TODO: Deal with not yet existing viewports
          componentOrInstruction.viewport = this.allViewports().find(vp => vp.name === componentOrInstruction.viewportName);
        }
        this.addedViewports.push(componentOrInstruction);
      } else {
        if (typeof viewport === 'string') {
          // TODO: Deal with not yet existing viewports
          viewport = this.allViewports().find(vp => vp.name === viewport);
        }
        this.addedViewports.push(new ViewportInstruction(componentOrInstruction, viewport));
      }
    } else if (this.lastNavigation) {
      this.navigator.navigate({ instruction: '', fullStateInstruction: '', repeating: true }).catch(error => { throw error; });
      // Don't wait for the (possibly slow) navigation
    }
  }

  public findScope(element: Element): Scope {
    this.ensureRootScope();
    return this.closestScope(element);
  }

  // External API to get viewport by name
  public getViewport(name: string): Viewport {
    return this.allViewports().find(viewport => viewport.name === name);
  }

  // Called from the viewport custom element in attached()
  public addViewport(name: string, element: Element, context: IRenderContext, options?: IViewportOptions): Viewport {
    Reporter.write(10000, 'Viewport added', name, element);
    const parentScope = this.findScope(element);
    return parentScope.addViewport(name, element, context, options);
  }
  // Called from the viewport custom element
  public removeViewport(viewport: Viewport, element: Element, context: IRenderContext): void {
    // TODO: There's something hinky with remove!
    const scope = viewport.owningScope;
    if (!scope.removeViewport(viewport, element, context)) {
      this.removeScope(scope);
    }
  }
  public allViewports(): Viewport[] {
    this.ensureRootScope();
    return this.rootScope.allViewports();
  }

  public removeScope(scope: Scope): void {
    if (scope !== this.rootScope) {
      scope.removeScope();
      const index = this.scopes.indexOf(scope);
      if (index >= 0) {
        this.scopes.splice(index, 1);
      }
    }
  }

  public goto(pathOrViewports: string | Record<string, Viewport>, title?: string, data?: Record<string, unknown>, replace: boolean = false): Promise<void> {
    const entry: INavigationEntry = {
      instruction: pathOrViewports as string,
      fullStateInstruction: null,
      title: title,
      data: data,
      fromBrowser: false,
    };
    if (typeof pathOrViewports === 'string') {
      const [path, search] = pathOrViewports.split('?');
      entry.instruction = path;
      entry.query = search;
    }
    entry.replacing = replace;
    return this.navigator.navigate(entry);
  }

  public replace(pathOrViewports: string | Record<string, Viewport>, title?: string, data?: Record<string, unknown>): Promise<void> {
    return this.goto(pathOrViewports, title, data, true);
  }

  public refresh(): Promise<void> {
    return this.navigator.refresh();
  }

  public back(): Promise<void> {
    return this.navigator.go(-1);
  }

  public forward(): Promise<void> {
    return this.navigator.go(1);
  }

  public setNav(name: string, routes: INavRoute[]): void {
    const nav = this.findNav(name);
    if (nav) {
      nav.routes = [];
    }
    this.addNav(name, routes);
  }
  public addNav(name: string, routes: INavRoute[]): void {
    let nav = this.navs[name];
    if (!nav) {
      nav = this.navs[name] = new Nav(this, name);
    }
    nav.addRoutes(routes);
    this.navs[name] = new Nav(nav.router, nav.name, nav.routes);
  }
  public findNav(name: string): Nav {
    return this.navs[name];
  }

  private async cancelNavigation(updatedViewports: Viewport[], qInstruction: QueueItem<INavigationInstruction>): Promise<void> {
    // TODO: Take care of disabling viewports when cancelling and stateful!
    updatedViewports.forEach((viewport) => {
      viewport.abortContentChange().catch(error => { throw error; });
    });
    await this.navigator.cancel(qInstruction as INavigationInstruction);
    this.processingNavigation = null;
    qInstruction.resolve();
  }

  private ensureRootScope(): void {
    if (!this.rootScope) {
      const root = this.container.get(Aurelia).root;
      this.rootScope = new Scope(this, root.host as Element, root.controller.context, null);
      this.scopes.push(this.rootScope);
    }
  }

  private closestScope(element: Element): Scope {
    let el: any = element;
    while (!el.$controller && el.parentElement) {
      el = el.parentElement;
    }
    let controller = el.$controller;
    while (controller) {
      if (controller.host) {
        const viewport = this.allViewports().find((item) => item.element === controller.host);
        if (viewport && (viewport.scope || viewport.owningScope)) {
          return viewport.scope || viewport.owningScope;
        }
      }
      controller = controller.parent;
    }
    return this.rootScope;

    // let el = element;
    // while (el.parentElement) {
    //   const viewport = this.allViewports().find((item) => item.element === el);
    //   if (viewport && viewport.owningScope) {
    //     return viewport.owningScope;
    //   }
    //   el = el.parentElement;
    // }
    // return this.rootScope;

    // TODO: It would be better if it was something like this
    // const el = closestCustomElement(element);
    // let container: ChildContainer = el.$customElement.$context.get(IContainer);
    // while (container) {
    //   const scope = this.scopes.find((item) => item.context.get(IContainer) === container);
    //   if (scope) {
    //     return scope;
    //   }
    //   const viewport = this.allViewports().find((item) => item.context && item.context.get(IContainer) === container);
    //   if (viewport && viewport.owningScope) {
    //     return viewport.owningScope;
    //   }
    //   container = container.parent;
    // }
  }

  private replacePaths(instruction: INavigationInstruction): Promise<void> {
    this.activeComponents = this.rootScope.viewportStates(true, true);
    this.activeComponents = this.instructionResolver.removeStateDuplicates(this.activeComponents);

    let viewportStates = this.rootScope.viewportStates();
    viewportStates = this.instructionResolver.removeStateDuplicates(viewportStates);
    let state = this.instructionResolver.stateStringsToString(viewportStates);
    if (this.options.transformToUrl) {
      const routeOrInstructions = this.options.transformToUrl(this.instructionResolver.parseViewportInstructions(state), this);
      state = Array.isArray(routeOrInstructions) ? this.instructionResolver.stringifyViewportInstructions(routeOrInstructions) : routeOrInstructions;
    }

    let fullViewportStates = this.rootScope.viewportStates(true);
    fullViewportStates = this.instructionResolver.removeStateDuplicates(fullViewportStates);
    const query = (instruction.query && instruction.query.length ? `?${instruction.query}` : '');

    instruction.path = state + query;
    instruction.fullStateInstruction = this.instructionResolver.stateStringsToString(fullViewportStates, true) + query;
    return Promise.resolve();
  }
}
