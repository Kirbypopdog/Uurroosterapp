// #157: de fabriek voor een router die async fouten opvangt.
//
// Deze code stond in server.js, waar hij één router omwikkelde. Bij het
// opsplitsen krijgt elk domein zijn eigen router, en die moeten allemaal
// dezelfde opvang hebben. Eén vergeten router betekent dat de routes daarin
// terugvallen op het gedrag van vóór #380: een verzoek dat geen antwoord
// krijgt en een knop die eindeloos blijft draaien.
//
// Daarom is het een fabriek en geen losse functie die je moet onthouden toe te
// passen: maakRouter() geeft nooit een onbeschermde router terug.
const express = require('express');

// #380: Express 4 kent geen opvang voor een async handler die afwijst. Een
// rejection vóór de try van een route, zoals een mislukte pool.connect(), kwam
// daardoor nergens terecht. De rejection gaat nu naar next(err) en daarmee naar
// de foutmiddleware, die een 500 stuurt tenzij de route zelf al geantwoord heeft.
//
// Alleen async handlers worden omwikkeld: een gewone handler die gooit vangt
// Express zelf al op, en middleware met vier parameters is een foutafhandelaar
// en mag niet van vorm veranderen.
function vangAsyncFouten(handler) {
  if (typeof handler !== 'function' || handler.length >= 4) return handler;
  // Een Express-router is zelf ook een functie, en die mag niet omwikkeld
  // worden: het omhulsel heeft geen .stack, dus de routes erin zijn daarna
  // onzichtbaar voor alles wat de router uitleest. Ze werken nog wel, maar de
  // inventaristest ziet ze niet meer staan, en die is er juist om te bewaken
  // dat er bij het opsplitsen niets verdwijnt. Een router heeft zijn eigen
  // opvang al, want hij komt ook uit maakRouter().
  if (Array.isArray(handler.stack)) return handler;
  const omwikkeld = function (req, res, next) {
    let uitkomst;
    try {
      uitkomst = handler.call(this, req, res, next);
    } catch (fout) {
      return next(fout);
    }
    if (uitkomst && typeof uitkomst.then === 'function') {
      uitkomst.catch(next);
    }
    return uitkomst;
  };
  // De naam meenemen, anders heet elke route in een stacktrace 'omwikkeld'.
  Object.defineProperty(omwikkeld, 'name', { value: handler.name || 'route' });
  return omwikkeld;
}

function maakRouter() {
  const router = express.Router();
  for (const methode of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
    const origineel = router[methode].bind(router);
    router[methode] = (...argumenten) => {
      const [eerste, ...rest] = argumenten;
      if (typeof eerste === 'string' || eerste instanceof RegExp || Array.isArray(eerste)) {
        return origineel(eerste, ...rest.map(vangAsyncFouten));
      }
      return origineel(...argumenten.map(vangAsyncFouten));
    };
  }
  return router;
}

module.exports = { maakRouter, vangAsyncFouten };
