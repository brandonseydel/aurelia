import {
  HTMLTestContext,
  TestContext,
} from '@aurelia/testing';
import {
  BasicConfiguration as BasicBrowserConfiguration
} from '@aurelia/jit-html-browser';
import {
  Reporter,
  LogLevel,
} from '@aurelia/kernel';

Reporter.level = LogLevel.error;

function createBrowserTestContext(): HTMLTestContext {
  return HTMLTestContext.create(
    BasicBrowserConfiguration,
    window,
    UIEvent,
    Event,
    CustomEvent,
    Node,
    Element,
    HTMLElement,
    HTMLDivElement,
    Text,
    Comment,
    DOMParser
  );
}

function initializeBrowserTestContext(): void {
  TestContext.createHTMLTestContext = createBrowserTestContext;
  // Just trigger the HTMLDOM to be resolved once so it sets the DOM globals
  TestContext.createHTMLTestContext().dom.createElement('div');
}


initializeBrowserTestContext();

const testContext = require.context('.', true, /router.*?\.spec\.js$/i);
testContext.keys().forEach(testContext);
