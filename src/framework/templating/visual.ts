import { View, IRender } from "./view";
import { Template } from "./template";
import { Scope } from "../binding/scope";
import { IBindScope } from "../binding/binding";
import { IAttach } from "./component";

export interface IVisual extends IBindScope, IAttach, IRender {
  isBound: boolean;
}

export class Visual implements IVisual {
  $view: View;
  isBound = false;

  constructor(template: Template) {
    this.$view = template.create();
  }

  bind(scope: Scope) {
    this.isBound = true;
  }

  unbind() {
    this.isBound = false;
  }

  attach() { }
  detach() { }
}
