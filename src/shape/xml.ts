/**
 * @fileOverview 从xml建立自定义Node，包含update
 * @author xuzhi.mxz@antfin.com
 */

import JSON5 from 'json5';
import lodash from 'lodash';

/**
 * 内部用于最终实际渲染的结构
 */
interface NodeInstructure {
  type: string,
  attrs: { [key: string]: any },
  children: NodeInstructure[],
  bbox: {
    x: number, y: number, width: number, height: number
  }
}

const keyConvert = str => str.split('-').reduce((a, b) => a + b.charAt(0).toUpperCase() + b.slice(1));

/**
 * 简单的一个{{}}模板渲染，不包含任何复杂语法
 * @param xml 
 */
export const xmlDataRenderer = (xml: string) => data => {
  return xml.split(/{{|}}/g).map(text => {
    if (/^[\w.]+$/g.test(text.trim())) {
      return lodash.get(data, text.trim(), text)
    }
    return text;
  }).join('')
}

/**
 * 解析XML，并转化为相应的JSON结构
 * @param xml xml解析后的节点
 */
export function parseXML(xml: HTMLElement) {
  let attrs = {} as { [key: string]: any };
  const keys = xml.getAttributeNames && xml.getAttributeNames() || [] as string[];
  const children = xml.children && Array.from(xml.children).map(e => parseXML(e as HTMLElement));
  const rst = {} as NodeInstructure;
  const tagName = xml.tagName ? xml.tagName.toLowerCase() : 'group';

  if (tagName === 'text') {
    attrs.text = xml.innerText;
  }

  rst.type = tagName;

  Array.from(keys).forEach(k => {
    const key = keyConvert(k)
    const val = xml.getAttribute(k);
    try {
      if (key === 'style' || key === 'attrs') {
        const style = JSON5.parse(val);
        attrs = {
          ...attrs,
          ...style,
        };
      } else {
        rst[key] = JSON5.parse(val);
      }
    } catch (e) {
      if (key === 'style') {
        throw e;
      }
      rst[key] = val;
    }
  });

  rst.attrs = attrs;

  if (children.length) {
    rst.children = children
  }

  return rst;
}

/**
 * 根据偏移量和内部节点最终的bounding box来得出该shape最终的bbox
 */
export function getBBox(node: NodeInstructure, offset: { x: number, y: number }, chilrenBBox: { width: number, height: number }) {
  const { attrs = {} } = node;
  const bbox = {
    x: offset.x || 0, y: offset.y || 0, width: chilrenBBox.width || 0, height: chilrenBBox.height || 0,
  };

  let shapeHeight, shapeWidth;
  switch (node.type) {
    case 'maker':
    case 'circle':
      if (attrs.r) {
        shapeWidth = 2 * attrs.r;
        shapeHeight = 2 * attrs.r;
      }
      break;
    case 'ellipse':
      if (attrs.rx && attrs.ry) {
        shapeWidth = 2 * attrs.rx;
        shapeHeight = 2 * attrs.ry;
      }
      break;
    case 'text':
      if (attrs.text) {
        shapeWidth = attrs.text.length * (attrs.length);
        shapeHeight = 16;
        bbox.y += shapeHeight;
        node.attrs = {
          fontSize: 12,
          fill: '#000',
          ...attrs,
        }
      }
      break;
    default:
      if (attrs.width) {
        shapeWidth = attrs.width
      }
      if (attrs.height) {
        shapeHeight = attrs.height
      }
  }
  if (shapeHeight >= 0) {
    bbox.height = shapeHeight;
  }
  if (shapeWidth >= 0) {
    bbox.width = shapeWidth;
  }

  if (attrs.marginTop) {
    bbox.y += attrs.marginTop;
  }

  if (attrs.marginLeft) {
    bbox.x += attrs.marginLeft;
  }

  return bbox;
}

/**
 * 把从xml计算出的结构填上位置信息，补全attrs
 * @param target 
 * @param lastOffset 
 */
export function generateTarget(target: NodeInstructure, lastOffset = { x: 0, y: 0 }) {
  let defaultBbox = {
    x: 0, y: 0, width: 0, height: 0, ...lastOffset
  };

  if (target.children?.length) {
    const { attrs = {} } = target;
    const { marginTop } = attrs;
    const offset = { ...lastOffset };

    if (marginTop) {
      offset.y += marginTop
    }

    for (let index = 0; index < target.children.length; index++) {
      target.children[index].attrs.key = (attrs.key || 'root') + '-' + index;
      const node = generateTarget(target.children[index], offset);
      if (node.bbox) {
        const { bbox } = node;
        offset.y += node.bbox.height;
        if (bbox.width + bbox.x > defaultBbox.width) {
          defaultBbox.width = bbox.width + bbox.x;
        }
        if (bbox.height + bbox.y > defaultBbox.height) {
          defaultBbox.height = bbox.height + bbox.y;
        }
      }
    }
  }

  target.bbox = getBBox(target, lastOffset, defaultBbox);

  target.attrs = {
    ...target.attrs,
    ...target.bbox,
  }

  return target;
}

/**
 * 对比前后两个最终计算出来的node，并对比出最小改动,
 * 动作： 'add' 添加节点 ｜ ’delete‘ 删除节点 ｜ ’change‘ 改变节点attrs ｜ 'restructure' 重构节点
 * @param nowTarget
 * @param formerTarget 
 */
export function compareTwoTarget(nowTarget: NodeInstructure, formerTarget: NodeInstructure) {
  const { type } = nowTarget || {};
  const { key } = formerTarget?.attrs || {};

  if (key && nowTarget) {
    nowTarget.attrs.key = key;
  }

  if (!nowTarget && formerTarget) {
    return {
      action: 'delete',
      val: formerTarget,
      type,
      key
    }
  }
  if (nowTarget && !formerTarget) {
    return {
      action: 'add',
      val: nowTarget,
      type
    }
  }
  if (!nowTarget && !formerTarget) {
    return {
      action: 'same',
      type
    }
  }
  const children = [];

  if (nowTarget.children?.length > 0 || formerTarget.children?.length > 0) {
    const length = Math.max(nowTarget.children?.length, formerTarget.children?.length);
    const formerChilren = formerTarget.children || [];
    const nowChilren = nowTarget.children || [];

    for (let index = 0; index < length; index += 1) {
      children.push(compareTwoTarget(nowChilren[index], formerChilren[index]))
    }
  }

  const formerKeys = Object.keys(formerTarget.attrs);
  const nowKeys = Object.keys(nowTarget.attrs);

  if (formerTarget.type !== nowTarget.type) {
    return {
      action: 'restructure',
      nowTarget,
      formerTarget,
      key,
      children
    }
  }

  if (formerKeys.filter(e => e !== 'children').some(e => nowTarget.attrs[e] !== formerTarget.attrs[e] || !nowKeys.includes(e))) {
    return {
      action: 'change',
      val: nowTarget,
      children,
      type,
      key
    }
  }

  return {
    action: 'same',
    children,
    type,
    key
  }
}

/**
 * 根据xml或者返回xml的函数构建自定义节点的结构
 * @param gen 
 */
export function createNodeFromXML(gen: string | ((node: any) => string)) {
  const structures = new Map();
  const compileXML = cfg => {
    const target = typeof gen === 'function' ? gen(cfg) : xmlDataRenderer(gen)(cfg);
    const xmlParser = document.createElement('div');
    xmlParser.innerHTML = target;
    const xml = xmlParser.children[0] as HTMLElement;

    return generateTarget(parseXML(xml));
  }

  return {
    draw(cfg, group) {
      const target = compileXML(cfg);
      let keyshape = group;
      const renderTarget = (target) => {
        const { attrs = {}, bbox, type, children, ...rest } = target;
        if (target.type !== 'group') {
          const shape = group.addShape(target.type, {
            attrs,
            origin: {
              bbox,
              type,
              children
            },
            ...rest
          });
          if (target.keyshape) {
            keyshape = shape;
          }
        }

        if (target.children) {
          target.children.forEach(n => renderTarget(n))
        }
      }

      renderTarget(target);

      structures.set(cfg.id, [target]);

      return keyshape;
    },
    setState(name, value, node) {
      const cfg = Object.assign({}, node.get('model') || {});
      // 根据状态构造style
      if (value && cfg.style && cfg.style[name]) {
        cfg.style = { ...cfg.style, ...cfg.style[name] }
      }
      // 根据上下文更新
      this.update(cfg, node);
    },
    update(cfg, node) {
      if (!structures.get(cfg.id)) {
        structures.set(cfg.id, [])
      }
      const container = node.getContainer();
      const children = container.get('children');
      const target = compileXML(cfg);
      const lastTarget = structures.get(cfg.id).pop();
      const diff = compareTwoTarget(target, lastTarget);
      const addShape = node => {
        container.addShape(node.type, { attrs: node.attrs });
        if (node.children?.length) {
          node.children.map(e => addShape(e))
        }
      };
      const delShape = node => {
        const targetShape = children.find(e => e.attrs.key === node.attrs.key)
        container.removeChild(targetShape);
        if (node.children?.length) {
          node.children.map(e => delShape(e))
        }
      };
      const updateTarget = target => {
        const { key } = target;
        if (target.type !== 'group') {
          const targetShape = children.find(e => e.attrs.key === key)
          switch (target.action) {
            case 'change':
              if (targetShape) {
                targetShape.attr(target.val.attrs);
              }
              break;
            case 'add':
              addShape(target.val)
              break;
            case 'delete':
              delShape(target.val)
              break;
            case 'restructure':
              delShape(target.formerTarget)
              addShape(target.nowTarget)
              break;
          }
        }

        if (target.children) {
          target.children.forEach(n => updateTarget(n))
        }
      }

      updateTarget(diff);

      structures.get(cfg.id).push(target);
    },
    getAnchorPoints() {
      return [
        [0, 0.5],
        [1, 0.5],
        [0.5, 1],
        [0.5, 0],
      ];
    }
  }
}