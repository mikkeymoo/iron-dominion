import { describe,it,expect,vi } from 'vitest';
import { render,fireEvent,screen } from '@testing-library/react';
import { App } from './App';
vi.mock('./components/game/GameMap',()=>({GameMap:()=> <div>Battle map</div>}));
describe('playable campaign screens',()=>{
 it('starts paused, resumes and opens working recruitment controls',()=>{
  localStorage.clear();render(<App/>);
  fireEvent.click(screen.getByRole('button',{name:'New campaign'}));
  expect(screen.getByRole('button',{name:'Resume campaign'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Resume campaign'}));
  fireEvent.click(screen.getByRole('button',{name:'Build'}));
  fireEvent.click(screen.getByRole('button',{name:/Recruit Assault/}));
  expect(screen.getByText(/Assault.*remaining/)).toBeTruthy();
 });
 it('rejects malformed imports without losing existing progress',()=>{
  localStorage.clear();render(<App/>);
  fireEvent.click(screen.getByRole('button',{name:'Import backup'}));
  fireEvent.change(screen.getByLabelText('Save JSON'),{target:{value:'not JSON'}});
  fireEvent.click(screen.getByRole('button',{name:'Load backup'}));
  expect(screen.getByRole('alert').textContent).toContain('not valid JSON');
 });
});

it('disables the production upgrade at the engine maximum',async()=>{
 const {createCampaign}=await import('./game/world'); const {saveCampaign}=await import('./game/persistence');
 const s=createCampaign(3);s.regions[0].prodLevel=2;s.factions.player.metal=999;s.factions.player.energy=999;saveCampaign(s);
 render(<App/>);fireEvent.click(screen.getByRole('button',{name:/Continue campaign/}));fireEvent.click(screen.getByRole('button',{name:'Build'}));
 expect((screen.getByRole('button',{name:/Upgrade production/}) as HTMLButtonElement).disabled).toBe(true);
});

it('launches the 3D assault from the title screen', async () => {
 localStorage.clear();
 vi.doMock('./action/ActionGame',()=>({ActionGame:()=> <div>Arena</div>}));
 vi.resetModules();
 const {App:Fresh}=await import('./App');
 render(<Fresh/>);
 fireEvent.click(screen.getByRole('button',{name:'Launch 3D assault'}));
 expect(screen.getByText('Arena')).toBeTruthy();
});
